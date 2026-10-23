import os

from celery import Celery

app = Celery(
    "worker",
    broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    include=["worker.tasks"],
)
app.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
    task_routes={
        "worker.tasks.stitch_panorama": {"queue": "heavy"},
        "worker.tasks.tile_panorama": {"queue": "heavy"},
        "worker.tasks.build_map_version": {"queue": "default"},
    },
)
