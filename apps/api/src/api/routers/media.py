"""Serves stored media (tiles, previews, underlays) for local and single-host setups.

Keys contain random UUIDs, so files are unguessable and safe to cache forever.
In production Caddy or a CDN can serve STORAGE_DIR directly.
"""

import mimetypes

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from api.storage import get_storage

router = APIRouter(tags=["media"], include_in_schema=False)

SERVED_PREFIXES = ("panos/", "maps/")

# Windows has no WebP entry by default; with `nosniff` a wrong type would block the images.
mimetypes.add_type("image/webp", ".webp")


@router.get("/media/{key:path}")
async def get_media(key: str) -> FileResponse:
    # Raw capture frames are never served publicly.
    if not key.startswith(SERVED_PREFIXES):
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    try:
        path = get_storage().path(key)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND) from exc
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})
