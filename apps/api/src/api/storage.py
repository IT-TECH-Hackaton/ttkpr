"""File storage for uploads and generated media.

Local directory for development and single-host deployments; keys are opaque paths like
`panos/<uuid>/tiles/2048/0_1.webp`. The worker uses the same layout (STORAGE_DIR).
"""

from pathlib import Path

from api.config import get_settings


class Storage:
    def __init__(self, root: Path, media_url: str) -> None:
        self.root = root.resolve()
        self.media_url = media_url.rstrip("/")

    def path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        if not target.is_relative_to(self.root):
            raise ValueError(f"Key escapes storage root: {key}")
        return target

    def put(self, key: str, data: bytes) -> str:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return self.url(key)

    def url(self, key: str) -> str:
        return f"{self.media_url}/{key}"


def get_storage() -> Storage:
    settings = get_settings()
    return Storage(settings.storage_dir, settings.media_url)
