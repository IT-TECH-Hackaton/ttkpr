"""Serves stored media (tiles, previews, underlays, published bundles) in development.

Keys contain random UUIDs, so files are unguessable and safe to cache forever. In production
Caddy serves the same two prefixes straight from the storage volume (infra/Caddyfile).
"""

import mimetypes

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from api.storage import get_storage

router = APIRouter(tags=["media"], include_in_schema=False)

# Raw capture frames, videos (captures/) and room scans (scans/) are never served.
SERVED_PREFIXES = ("panos/", "maps/")

# Windows has no WebP entry by default; with `nosniff` a wrong type would block the images.
mimetypes.add_type("image/webp", ".webp")


@router.get("/media/{key:path}")
async def get_media(key: str) -> FileResponse:
    storage = get_storage()
    try:
        path = storage.path(key)  # refuses `..`, so "panos/../captures/..." never gets here
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND) from exc
    if not key.startswith(SERVED_PREFIXES) or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    # And no link may lead outside the served folders.
    try:
        real = path.resolve(strict=True).relative_to(storage.root).as_posix()
    except (OSError, ValueError) as exc:  # removed meanwhile, or a link out of storage
        raise HTTPException(status.HTTP_404_NOT_FOUND) from exc
    if not real.startswith(SERVED_PREFIXES):
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})
