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
    # A stuck or runaway stitch is killed instead of holding the heavy queue forever; the
    # task marks the panorama failed on the soft limit. Children are recycled after big jobs.
    task_soft_time_limit=900,
    task_time_limit=1000,
    worker_max_memory_per_child=3_000_000,  # KiB
    # Video tasks set longer limits of their own (worker.tasks).
    task_routes={
        "worker.tasks.stitch_panorama": {"queue": "heavy"},
        "worker.tasks.tile_panorama": {"queue": "heavy"},
        "worker.tasks.stitch_video": {"queue": "heavy"},
        "worker.tasks.scan_room": {"queue": "heavy"},
        "worker.tasks.recognize_plan": {"queue": "heavy"},
    },
)
