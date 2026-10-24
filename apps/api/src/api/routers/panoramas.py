import json
import shutil
import uuid
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from sqlalchemy import select

from api import queue, ratelimit
from api.access import capture_map, member_map
from api.deps import CurrentUser, DbSession
from api.models import Panorama, PanoramaStatus
from api.permissions import Permission
from api.schemas import (
    FrameMeta,
    PanoramaCreate,
    PanoramaOut,
    PanoramaUpdate,
    VideoPanoramaForm,
)
from api.storage import get_storage
from api.uploads import (
    VIDEO_PARTS,
    VIDEO_UPLOADS,
    VIDEO_UPLOADS_WINDOW_S,
    check_video,
    discard,
    ensure_image,
    multipart_body,
    read_limited,
    read_orientation,
    reencode_jpeg,
    store_video,
    video_form,
)
from map_schema.models import PanoTiles

router = APIRouter(tags=["panoramas"])

MIN_FRAMES = 6


def to_out(pano: Panorama) -> PanoramaOut:
    return PanoramaOut(
        id=pano.id,
        map_id=pano.map_id,
        level_id=pano.level_id,
        position=(pano.lon, pano.lat),
        heading_deg=pano.heading_deg,
        camera_height_m=pano.camera_height_m,
        title=pano.title,
        source=pano.source,
        status=pano.status,
        progress=pano.progress,
        error=pano.error,
        frame_count=pano.frame_count,
        tiles=PanoTiles.model_validate(pano.tiles) if pano.tiles else None,
        quality=pano.quality,
        created_at=pano.created_at,
    )


async def _load(db: DbSession, pano_id: uuid.UUID) -> Panorama:
    pano = await db.get(Panorama, pano_id)
    if pano is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Панорама не найдена")
    return pano


@router.get("/api/maps/{map_id}/panoramas", response_model=list[PanoramaOut])
async def list_panoramas(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[PanoramaOut]:
    await member_map(db, map_id, user)
    rows = await db.scalars(
        select(Panorama).where(Panorama.map_id == map_id).order_by(Panorama.created_at)
    )
    return [to_out(p) for p in rows]


@router.post(
    "/api/maps/{map_id}/panoramas",
    response_model=PanoramaOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_capture(
    map_id: uuid.UUID, body: PanoramaCreate, request: Request, db: DbSession
) -> PanoramaOut:
    """Starts a phone capture; frames follow with uploadFrame, then startStitching."""
    await capture_map(request, db, map_id)
    pano = Panorama(
        map_id=map_id,
        level_id=body.level_id,
        lon=body.position[0],
        lat=body.position[1],
        heading_deg=body.heading_deg or 0.0,
        title=body.title,
        source="capture",
        status=PanoramaStatus.UPLOADING,
        frame_count=body.frame_count,
        capture_meta={"fovDeg": body.fov_deg, "device": body.device, "frames": {}},
    )
    db.add(pano)
    await db.commit()
    return to_out(pano)


@router.put("/api/panoramas/{pano_id}/frames/{index}", response_model=PanoramaOut)
async def upload_frame(
    pano_id: uuid.UUID,
    index: int,
    file: UploadFile,
    meta: Annotated[str, Form(description="FrameMeta as JSON")],
    request: Request,
    db: DbSession,
) -> PanoramaOut:
    pano = await _load(db, pano_id)
    await capture_map(request, db, pano.map_id)
    if pano.status != PanoramaStatus.UPLOADING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Съёмка уже завершена")
    if not 0 <= index < pano.frame_count:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Неверный номер кадра")
    try:
        frame = FrameMeta.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Неверные данные кадра") from exc

    data = await read_limited(file, max_mb=10)
    ensure_image(data, jpeg_only=True)
    jpeg = await run_in_threadpool(reencode_jpeg, data)
    await run_in_threadpool(get_storage().put, f"captures/{pano_id}/{index:02d}.jpg", jpeg)
    # The phone sends frames in parallel: re-read the row under a lock (held only for this
    # update, not the re-encoding), or each upload writes back the frame list it read and the
    # others' frames are lost.
    await db.refresh(pano, with_for_update=True)
    if pano.status != PanoramaStatus.UPLOADING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Съёмка уже завершена")
    frames = dict(pano.capture_meta.get("frames", {}))
    frames[str(index)] = frame.model_dump(mode="json", by_alias=True)
    pano.capture_meta = {**pano.capture_meta, "frames": frames}
    pano.progress = round(len(frames) / pano.frame_count * 100)
    await db.commit()
    return to_out(pano)


# Failed panoramas of these sources are retried as they are: their input is already stored.
RETRY_TASKS = {"video": "worker.tasks.stitch_video", "upload": "worker.tasks.tile_panorama"}


@router.post("/api/panoramas/{pano_id}/stitch", response_model=PanoramaOut)
async def start_stitching(pano_id: uuid.UUID, request: Request, db: DbSession) -> PanoramaOut:
    """Stitches the uploaded frames; for a failed video or uploaded panorama, tries again."""
    pano = await _load(db, pano_id)
    await capture_map(request, db, pano.map_id)
    # Same lock as uploadFrame: a frame still being saved is either counted or refused.
    await db.refresh(pano, with_for_update=True)
    if pano.status == PanoramaStatus.PROCESSING:
        return to_out(pano)  # already started: the phone retried after a lost response
    if pano.status not in (PanoramaStatus.UPLOADING, PanoramaStatus.FAILED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Панорама уже готова")
    task = RETRY_TASKS.get(pano.source)
    if task is None:
        frames = pano.capture_meta.get("frames", {})
        if len(frames) < MIN_FRAMES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"Нужно хотя бы {MIN_FRAMES} кадров"
            )
        pano.frame_count = len(frames)
        task = "worker.tasks.stitch_panorama"
    pano.status = PanoramaStatus.PROCESSING
    pano.progress = 0
    pano.error = None
    await db.commit()
    await queue.enqueue_or_fail(db, pano, task)
    return to_out(pano)


@router.post(
    "/api/maps/{map_id}/panoramas/upload",
    response_model=PanoramaOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_panorama(
    map_id: uuid.UUID,
    file: UploadFile,
    level_id: Annotated[str, Form(alias="levelId", min_length=1, max_length=64)],
    lon: Annotated[float, Form()],
    lat: Annotated[float, Form()],
    db: DbSession,
    user: CurrentUser,
    heading_deg: Annotated[float, Form(alias="headingDeg")] = 0.0,
) -> PanoramaOut:
    """Ready-made 2:1 equirectangular panorama (360 camera, phone photosphere)."""
    await member_map(db, map_id, user, Permission.CAPTURE)
    data = await read_limited(file)
    ensure_image(data)
    pano = Panorama(
        map_id=map_id,
        level_id=level_id,
        lon=lon,
        lat=lat,
        heading_deg=heading_deg,
        source="upload",
        status=PanoramaStatus.PROCESSING,
    )
    db.add(pano)
    await db.flush()
    jpeg = await run_in_threadpool(reencode_jpeg, data)
    await run_in_threadpool(get_storage().put, f"panos/{pano.id}/source.jpg", jpeg)
    await db.commit()
    await queue.enqueue_or_fail(db, pano, "worker.tasks.tile_panorama")
    return to_out(pano)


@router.post(
    "/api/maps/{map_id}/panoramas/video",
    response_model=PanoramaOut,
    status_code=status.HTTP_201_CREATED,
    openapi_extra=multipart_body(VideoPanoramaForm, VIDEO_PARTS, ("file",)),
)
async def upload_panorama_video(map_id: uuid.UUID, request: Request, db: DbSession) -> PanoramaOut:
    """Panorama from a video: stand in the middle and turn around once, phone upright.

    Same access as the photo capture: organizer session or the QR token (X-Capture-Token).
    Stored as captures/{id}/video.{webm|mp4|mov} (+ orientation.json), never served;
    worker.tasks.stitch_video makes the equirect and tiles, progress as for photo captures.
    """
    await capture_map(request, db, map_id)
    await ratelimit.limit(
        request, "video", VIDEO_UPLOADS, VIDEO_UPLOADS_WINDOW_S, subject=str(map_id)
    )
    # Hand the DB connection back while the video streams in (minutes on a slow network).
    await db.commit()
    pano_id = uuid.uuid4()
    async with video_form(request, VideoPanoramaForm) as (fields, file, orientation):
        container = await check_video(file)
        track = await read_orientation(orientation) if orientation else None
        stored = await store_video(file, container, track, f"captures/{pano_id}")
    pano = Panorama(
        id=pano_id,
        map_id=map_id,
        level_id=fields.level_id,
        lon=fields.lon,
        lat=fields.lat,
        heading_deg=(fields.heading_deg or 0.0) % 360,
        source="video",
        status=PanoramaStatus.PROCESSING,
        capture_meta={**stored, "fovDeg": track.fov_deg if track else None},
    )
    try:
        db.add(pano)
        await db.commit()
    except BaseException:
        discard(f"captures/{pano_id}")
        raise
    await queue.enqueue_or_fail(db, pano, "worker.tasks.stitch_video")
    return to_out(pano)


@router.get("/api/panoramas/{pano_id}", response_model=PanoramaOut)
async def get_panorama(pano_id: uuid.UUID, request: Request, db: DbSession) -> PanoramaOut:
    pano = await _load(db, pano_id)
    await capture_map(request, db, pano.map_id, Permission.VIEW)
    return to_out(pano)


@router.patch("/api/panoramas/{pano_id}", response_model=PanoramaOut)
async def update_panorama(
    pano_id: uuid.UUID, body: PanoramaUpdate, db: DbSession, user: CurrentUser
) -> PanoramaOut:
    pano = await _load(db, pano_id)
    await member_map(db, pano.map_id, user, Permission.EDIT)
    if body.level_id is not None:
        pano.level_id = body.level_id
    if body.position is not None:
        pano.lon, pano.lat = body.position
    if body.heading_deg is not None:
        pano.heading_deg = body.heading_deg % 360
    if body.title is not None:
        pano.title = body.title
    await db.commit()
    return to_out(pano)


@router.delete("/api/panoramas/{pano_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_panorama(pano_id: uuid.UUID, db: DbSession, user: CurrentUser) -> None:
    pano = await _load(db, pano_id)
    await member_map(db, pano.map_id, user, Permission.EDIT)
    await db.delete(pano)
    await db.commit()
    storage = get_storage()
    for prefix in (f"captures/{pano_id}", f"panos/{pano_id}"):
        shutil.rmtree(storage.path(prefix), ignore_errors=True)
