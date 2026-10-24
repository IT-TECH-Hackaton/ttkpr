from functools import lru_cache

from celery import Celery
from fastapi import HTTPException, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession

from api.config import get_settings
from api.models import Panorama, PanoramaStatus, PlanImport, RoomScan, ScanStatus

# Must match the queues the worker consumes (apps/worker/src/worker/celery_app.py):
# routes configured only on the worker do not apply to messages sent from here.
QUEUES = {
    "worker.tasks.stitch_panorama": "heavy",
    "worker.tasks.tile_panorama": "heavy",
    "worker.tasks.stitch_video": "heavy",
    "worker.tasks.scan_room": "heavy",
    "worker.tasks.recognize_plan": "heavy",
}


@lru_cache
def _celery() -> Celery:
    app = Celery(broker=get_settings().redis_url)
    app.conf.broker_connection_timeout = 3
    return app


def enqueue(task_name: str, *args: str) -> None:
    """Tasks are sent by name; implementations live in apps/worker (worker.tasks)."""
    try:
        _celery().send_task(
            task_name, args=list(args), queue=QUEUES.get(task_name, "default"), retry=False
        )
    except Exception as exc:  # broker down: fail fast instead of hanging the request
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Очередь обработки недоступна, попробуйте позже"
        ) from exc


async def enqueue_or_fail(
    db: AsyncSession, job: Panorama | RoomScan | PlanImport, task_name: str
) -> None:
    """A queue outage marks the job failed (retryable) instead of stuck in processing."""
    try:
        await run_in_threadpool(enqueue, task_name, str(job.id))
    except HTTPException:
        if isinstance(job, Panorama):
            job.status = PanoramaStatus.FAILED
        else:
            job.status = ScanStatus.FAILED
        job.error = "Очередь обработки недоступна — попробуйте ещё раз"
        await db.commit()
        raise
