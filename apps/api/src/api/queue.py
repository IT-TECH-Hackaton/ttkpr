from functools import lru_cache

from celery import Celery

from api.config import get_settings


@lru_cache
def _celery() -> Celery:
    return Celery(broker=get_settings().redis_url)


def enqueue(task_name: str, *args: str) -> None:
    """Tasks are sent by name; implementations live in apps/worker (worker.tasks)."""
    _celery().send_task(task_name, args=list(args))
