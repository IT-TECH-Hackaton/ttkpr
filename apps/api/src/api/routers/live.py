"""Live place statuses: open / busy / closed with a short note, changed without republishing.

Visitors poll the public live.json (CDN-cacheable for 15 s, ETag), organizers set statuses
per place. Only places that exist on the map get one, so live.json is never bigger than the
map itself.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from api.access import member_map, members_only
from api.deps import CurrentUser, DbSession
from api.http_cache import conditional_json
from api.models import Map, MapLive, MapVersion
from api.permissions import Permission
from api.routers.public import published_map
from api.schemas import LiveOut, LivePlace, LivePlaceOut, LiveUpdate

router = APIRouter(tags=["live"])

PoiId = Annotated[str, Path(min_length=1, max_length=64)]


def _live(rows: Sequence[MapLive]) -> LiveOut:
    return LiveOut(
        updated_at=max((r.updated_at for r in rows), default=None),
        places={
            r.poi_id: LivePlace(status=r.status, note=r.note, updated_at=r.updated_at) for r in rows
        },
    )


async def _rows(db: DbSession, map_id: uuid.UUID) -> Sequence[MapLive]:
    result = await db.scalars(
        select(MapLive).where(MapLive.map_id == map_id).order_by(MapLive.poi_id)
    )
    return result.all()


async def _has_poi(db: DbSession, found: Map, poi_id: str) -> bool:
    """In the draft, or in the published version (a place removed from the draft but still
    shown to visitors may still need a status)."""
    if any(p.get("id") == poi_id for p in found.draft.get("pois", [])):
        return True
    if found.published_version_id is None:
        return False
    hit = await db.scalar(
        select(MapVersion.id).where(
            MapVersion.id == found.published_version_id,
            MapVersion.bundle["pois"].contains([{"id": poi_id}]),
        )
    )
    return hit is not None


@router.put("/api/maps/{map_id}/live/{poi_id}", response_model=LivePlaceOut)
async def set_live_status(
    map_id: uuid.UUID, poi_id: PoiId, body: LiveUpdate, db: DbSession, user: CurrentUser
) -> LivePlaceOut:
    found = await member_map(db, map_id, user, Permission.EDIT)
    if not await _has_poi(db, found, poi_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Такой точки на карте нет")
    note = (body.note or "").strip() or None
    now = datetime.now(UTC)
    statement = insert(MapLive).values(
        map_id=map_id, poi_id=poi_id, status=body.status, note=note, updated_at=now
    )
    await db.execute(
        statement.on_conflict_do_update(
            index_elements=["map_id", "poi_id"],
            set_={"status": body.status, "note": note, "updated_at": now},
        )
    )
    await db.commit()
    return LivePlaceOut(poi_id=poi_id, status=body.status, note=note, updated_at=now)


@router.delete("/api/maps/{map_id}/live/{poi_id}", status_code=status.HTTP_204_NO_CONTENT)
async def clear_live_status(
    map_id: uuid.UUID, poi_id: PoiId, db: DbSession, user: CurrentUser
) -> None:
    """Back to no status. Idempotent: clearing a place without one is fine."""
    await member_map(db, map_id, user, Permission.EDIT)
    await db.execute(delete(MapLive).where(MapLive.map_id == map_id, MapLive.poi_id == poi_id))
    await db.commit()


@router.get("/api/maps/{map_id}/live", response_model=LiveOut)
async def list_live(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> LiveOut:
    """For the studio, also before the map is published."""
    await member_map(db, map_id, user)
    return _live(await _rows(db, map_id))


@router.get(
    "/api/public/maps/{slug}/live.json",
    response_model=LiveOut,
    responses={304: {"description": "Not modified (If-None-Match matched the ETag)"}},
)
async def get_live(slug: str, request: Request, db: DbSession) -> Response:
    """Statuses of the published map for visitors; members only for private maps."""
    found = await published_map(db, slug, request)
    live = _live(await _rows(db, found.id))
    return conditional_json(
        request,
        live.model_dump(mode="json", by_alias=True),
        "private, no-cache" if members_only(found.access_mode) else "public, max-age=15",
    )
