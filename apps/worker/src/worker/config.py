import os
from pathlib import Path

# apps/worker/src/worker/config.py -> repository root
REPO_ROOT = Path(__file__).resolve().parents[4]

STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", REPO_ROOT / "data" / "storage"))
MEDIA_URL = os.environ.get("MEDIA_URL", "/media").rstrip("/")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
# Same database as the API; the async driver is swapped for the sync one.
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+asyncpg://ttk:ttk@localhost:5432/ttk"
).replace("+asyncpg", "+psycopg")


def storage_path(key: str) -> Path:
    root = STORAGE_DIR.resolve()
    target = (root / key).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"Key escapes storage root: {key}")
    return target
