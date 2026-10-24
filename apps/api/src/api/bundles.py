"""Published bundles as static files: /media/maps/{map_id}/v/{n}/bundle.json.

Caddy (and a CDN in front of it) serve them straight from storage and cache them forever: a
version never changes, and the path is keyed by the map id, so a slug that later goes to another
map can never hit an old cached copy. Members-only maps never get a file — their bundle stays
behind the API route that checks the session.

Writers hold a lock on the map row (publish and access-mode changes: FOR UPDATE, the manifest's
lazy write: FOR SHARE), so a map switched to members-only cannot get a file written back.
"""

import gzip
import json
import logging
import shutil
import uuid
from typing import Any

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.access import members_only
from api.models import Map, MapVersion
from api.storage import get_storage

log = logging.getLogger(__name__)


def bundle_key(map_id: uuid.UUID, number: int) -> str:
    return f"maps/{map_id}/v/{number}/bundle.json"


def api_url(slug: str, number: int) -> str:
    """The session-checked route: members-only maps, and manifests saved before static files."""
    return f"/api/public/maps/{slug}/v/{number}/bundle.json"


def _write(map_id: uuid.UUID, number: int, bundle: dict[str, Any]) -> str:
    storage = get_storage()
    key = bundle_key(map_id, number)
    data = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode()
    # The gzip copy first: once bundle.json exists, Caddy can serve it precompressed.
    storage.put(f"{key}.gz", gzip.compress(data, compresslevel=9, mtime=0))
    return storage.put(key, data)


async def write_static(map_id: uuid.UUID, number: int, bundle: dict[str, Any]) -> str:
    """Writes the version's bundle.json (+ .gz); the caller holds the map row lock."""
    return await run_in_threadpool(_write, map_id, number, bundle)


def remove_static(map_id: uuid.UUID) -> None:
    """The map went members-only: none of its versions may stay reachable by URL."""
    shutil.rmtree(get_storage().path(f"maps/{map_id}/v"), ignore_errors=True)


def static_url(map_id: uuid.UUID, number: int) -> str | None:
    storage = get_storage()
    key = bundle_key(map_id, number)
    return storage.url(key) if storage.path(key).is_file() else None


async def published_static_url(db: AsyncSession, found: Map, number: int) -> str | None:
    """Static URL of the published version for the manifest, writing the file on first use
    (versions published before static bundles, the seed). None: use the API route."""
    if members_only(found.access_mode):
        return None
    if url := static_url(found.id, number):
        return url
    # Shares the lock with access-mode changes: re-read the mode under it.
    mode = await db.scalar(
        select(Map.access_mode).where(Map.id == found.id).with_for_update(read=True)
    )
    bundle = await db.scalar(
        select(MapVersion.bundle).where(MapVersion.map_id == found.id, MapVersion.number == number)
    )
    if mode is None or members_only(mode) or bundle is None:
        return None
    try:
        return await write_static(found.id, number, bundle)
    except OSError:
        log.exception("could not write the static bundle of map %s v%s", found.id, number)
        return None
