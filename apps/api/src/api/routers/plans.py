"""Plan recognition: a building plan (image or multi-page PDF) -> rooms, doors, stairs, floors.

The upload is checked and stored in plans/{id}/ (never served); worker.tasks.recognize_plan
writes status, progress and the result into plan_imports. The studio polls, previews the draft
and adds it to the plan itself (the draft document is only ever changed by the studio).
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from api import queue, ratelimit
from api.access import member_map
from api.deps import CurrentUser, DbSession
from api.models import PlanImport, ScanStatus
from api.permissions import Permission
from api.schemas import PlanImportOut
from api.storage import get_storage
from api.uploads import discard, ensure_image, read_limited

router = APIRouter(tags=["plans"])

PDF_MAGIC = b"%PDF-"
PLAN_IMPORTS = 20
PLAN_IMPORTS_WINDOW_S = 600


def _extension(data: bytes) -> str:
    if data.startswith(PDF_MAGIC):
        return "pdf"
    try:
        ensure_image(data)
    except HTTPException as exc:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Нужен план в PDF, JPEG, PNG или WebP"
        ) from exc
    return "img"


@router.post(
    "/api/maps/{map_id}/plan-imports",
    response_model=PlanImportOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_plan_import(
    map_id: uuid.UUID, file: UploadFile, request: Request, db: DbSession, user: CurrentUser
) -> PlanImport:
    """Start recognising a plan: an image or a PDF with one floor per page (up to 12)."""
    await member_map(db, map_id, user, Permission.EDIT)
    await ratelimit.limit(
        request, "plan-import", PLAN_IMPORTS, PLAN_IMPORTS_WINDOW_S, subject=str(map_id)
    )
    data = await read_limited(file)
    job_id = uuid.uuid4()
    key = f"plans/{job_id}/source.{_extension(data)}"
    await run_in_threadpool(get_storage().put, key, data)
    job = PlanImport(id=job_id, map_id=map_id, source_key=key, status=ScanStatus.PROCESSING)
    try:
        db.add(job)
        await db.commit()
    except BaseException:
        discard(f"plans/{job_id}")
        raise
    await queue.enqueue_or_fail(db, job, "worker.tasks.recognize_plan")
    return job


@router.get("/api/plan-imports/{job_id}", response_model=PlanImportOut)
async def get_plan_import(job_id: uuid.UUID, db: DbSession, user: CurrentUser) -> PlanImport:
    """Polled while the worker runs: status, progress, then the recognised plan."""
    job = await db.get(PlanImport, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Распознавание не найдено")
    await member_map(db, job.map_id, user, Permission.EDIT)
    return job
