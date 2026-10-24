"""Room scans: walk around a room filming, get its floor outline (worker.tasks.scan_room).

Uploaded like a video panorama (organizer session or QR capture token); the worker writes
status, progress and the result into room_scans, the studio polls and places the outline.
Files live in scans/{id}/ and are never served.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select

from api import queue, ratelimit
from api.access import capture_map, member_map
from api.deps import CurrentUser, DbSession
from api.models import RoomScan, ScanStatus
from api.permissions import Permission
from api.schemas import RoomScanForm, RoomScanOut
from api.uploads import (
    VIDEO_PARTS,
    VIDEO_UPLOADS,
    VIDEO_UPLOADS_WINDOW_S,
    check_video,
    discard,
    multipart_body,
    read_orientation,
    store_video,
    video_form,
)

router = APIRouter(tags=["scans"])


async def _load(db: DbSession, scan_id: uuid.UUID) -> RoomScan:
    scan = await db.get(RoomScan, scan_id)
    if scan is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Скан не найден")
    return scan


@router.post(
    "/api/maps/{map_id}/scans",
    response_model=RoomScanOut,
    status_code=status.HTTP_201_CREATED,
    openapi_extra=multipart_body(RoomScanForm, VIDEO_PARTS, ("file",)),
)
async def create_scan(map_id: uuid.UUID, request: Request, db: DbSession) -> RoomScan:
    """Video of one room, filmed walking along the walls with the camera at chest height."""
    await capture_map(request, db, map_id)
    await ratelimit.limit(
        request, "video", VIDEO_UPLOADS, VIDEO_UPLOADS_WINDOW_S, subject=str(map_id)
    )
    # Hand the DB connection back while the video streams in (minutes on a slow network).
    await db.commit()
    scan_id = uuid.uuid4()
    async with video_form(request, RoomScanForm) as (fields, file, orientation):
        container = await check_video(file)
        track = await read_orientation(orientation) if orientation else None
        await store_video(file, container, track, f"scans/{scan_id}")
    scan = RoomScan(
        id=scan_id,
        map_id=map_id,
        level_id=fields.level_id,
        camera_height_m=fields.camera_height_m,
        status=ScanStatus.PROCESSING,
    )
    try:
        db.add(scan)
        await db.commit()
    except BaseException:
        discard(f"scans/{scan_id}")
        raise
    await queue.enqueue_or_fail(db, scan, "worker.tasks.scan_room")
    return scan


@router.get("/api/maps/{map_id}/scans", response_model=list[RoomScanOut])
async def list_scans(map_id: uuid.UUID, request: Request, db: DbSession) -> list[RoomScan]:
    """Newest first. Also with the QR capture token, so the phone can show what it sent."""
    await capture_map(request, db, map_id, Permission.VIEW)
    rows = await db.scalars(
        select(RoomScan).where(RoomScan.map_id == map_id).order_by(RoomScan.created_at.desc())
    )
    return list(rows)


@router.get("/api/scans/{scan_id}", response_model=RoomScanOut)
async def get_scan(scan_id: uuid.UUID, request: Request, db: DbSession) -> RoomScan:
    """Polled while the worker runs: status, progress, then the result."""
    scan = await _load(db, scan_id)
    await capture_map(request, db, scan.map_id, Permission.VIEW)
    return scan


@router.delete("/api/scans/{scan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scan(scan_id: uuid.UUID, db: DbSession, user: CurrentUser) -> None:
    scan = await _load(db, scan_id)
    await member_map(db, scan.map_id, user, Permission.EDIT)
    await db.delete(scan)
    await db.commit()
    await run_in_threadpool(discard, f"scans/{scan_id}")
