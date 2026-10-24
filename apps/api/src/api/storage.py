"""File storage for uploads and generated media.

Local directory for development and single-host deployments; keys are opaque paths like
`panos/<uuid>/tiles/2048/0_1.webp`. The worker uses the same layout (STORAGE_DIR).
"""

import os
import secrets
from pathlib import Path

from api.config import get_settings


class Storage:
    def __init__(self, root: Path, media_url: str) -> None:
        self.root = root.resolve()
        self.media_url = media_url.rstrip("/")

    def path(self, key: str) -> Path:
        """Where a key lives. Keys are relative POSIX paths of plain names; the check is lexical
        (no `..`, `.`, empty parts, backslashes, drive letters or trailing dots and spaces that
        Windows would drop), so it cannot race with other requests creating directories, the
        way resolving a not-yet-existing path does on Windows."""
        parts = key.split("/")
        if (
            not key
            or "\\" in key
            or ":" in key
            or "\0" in key
            or any(part in ("", ".", "..") or part != part.rstrip(". ") for part in parts)
        ):
            raise ValueError(f"Invalid storage key: {key!r}")
        return self.root.joinpath(*parts)

    def put(self, key: str, data: bytes) -> str:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Written next to the target and renamed into place: Caddy, the worker and a parallel
        # request never see half a file.
        temp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
        try:
            temp.write_bytes(data)
            os.replace(temp, target)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        return self.url(key)

    def url(self, key: str) -> str:
        return f"{self.media_url}/{key}"


def get_storage() -> Storage:
    settings = get_settings()
    return Storage(settings.storage_dir, settings.media_url)
