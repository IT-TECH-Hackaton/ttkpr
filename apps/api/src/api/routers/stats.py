"""Visitor statistics: anonymous daily counters sent by the viewer, a summary for organizers."""

import json
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from api import ratelimit
from api.access import member_map
from api.deps import CurrentUser, DbSession
from api.models import AccessMode, Map, MapStat, MapVersion, StatKind
from api.schemas import StatCount, StatDay, StatsOut

router = APIRouter(tags=["stats"])

MAX_EVENTS = 50
MAX_BODY = 8 * 1024


@router.post("/api/public/maps/{slug}/events", status_code=status.HTTP_204_NO_CONTENT)
async def record_events(slug: str, request: Request, db: DbSession) -> Response:
    """Batch from navigator.sendBeacon (text/plain JSON: no CORS preflight, survives page close).

    Body: {"events": [{"kind": "poi", "key": "p-coffee"}, ...]}. Unknown kinds are dropped.
    """
    await ratelimit.limit(request, "events", max_hits=120, window_s=60)
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Слишком много событий")
    try:
        events = json.loads(raw or b"{}").get("events", [])
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Неверный формат") from exc
    found = await db.scalar(select(Map).where(Map.slug == slug))
    # Private maps are counted too (members open them); unpublished ones have no visitors.
    if found is None or found.published_version_id is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    counts: dict[tuple[str, str], int] = {}
    kinds = {k.value for k in StatKind}
    for event in events[:MAX_EVENTS] if isinstance(events, list) else []:
        if not isinstance(event, dict) or event.get("kind") not in kinds:
            continue
        key = (
            str(event.get("key") or "").strip().lower()[:120]
            if event["kind"] in ("search", "miss")
            else str(event.get("key") or "")[:120]
        )
        counts[(event["kind"], key)] = counts.get((event["kind"], key), 0) + 1
    if counts:
        today = datetime.now(UTC).date()
        statement = insert(MapStat).values(
            [
                {"map_id": found.id, "day": today, "kind": kind, "key": key, "count": n}
                for (kind, key), n in counts.items()
            ]
        )
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=["map_id", "day", "kind", "key"],
                set_={"count": MapStat.count + statement.excluded.count},
            )
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/maps/{map_id}/stats", response_model=StatsOut)
async def map_stats(
    map_id: uuid.UUID, db: DbSession, user: CurrentUser, days: int = 30
) -> StatsOut:
    found = await member_map(db, map_id, user)
    days = max(1, min(days, 365))
    since = datetime.now(UTC).date() - timedelta(days=days - 1)
    rows = (
        await db.execute(
            select(MapStat.kind, MapStat.key, MapStat.day, func.sum(MapStat.count))
            .where(MapStat.map_id == map_id, MapStat.day >= since)
            .group_by(MapStat.kind, MapStat.key, MapStat.day)
        )
    ).all()

    # Names from the published version (what visitors saw), falling back to the draft.
    document: dict[str, Any] = found.draft
    if found.published_version_id:
        version = await db.get(MapVersion, found.published_version_id)
        document = (version.bundle if version and version.bundle else None) or found.draft
    names = {
        **{p["id"]: p["name"] for p in document.get("pois", [])},
        **{t["id"]: t["name"] for t in document.get("tours", [])},
    }

    per_day: dict[date, int] = {}
    totals: dict[str, int] = {}
    by_key: dict[str, dict[str, int]] = {}
    for kind, key, day, n in rows:
        totals[kind] = totals.get(kind, 0) + n
        if kind == StatKind.VIEW:
            per_day[day] = per_day.get(day, 0) + n
        else:
            bucket = by_key.setdefault(kind, {})
            bucket[key] = bucket.get(key, 0) + n

    def top(kind: StatKind, limit: int = 10) -> list[StatCount]:
        items = sorted(by_key.get(kind, {}).items(), key=lambda kv: -kv[1])[:limit]
        result = []
        for key, n in items:
            if kind == StatKind.ROUTE and ">" in key:
                a, b = key.split(">", 1)
                label = f"{names.get(a, 'Точка на карте')} → {names.get(b, 'Точка на карте')}"
            else:
                label = names.get(key, key)
            result.append(StatCount(key=key, label=label, count=n))
        return result

    return StatsOut(
        days=[
            StatDay(day=since + timedelta(days=i), views=per_day.get(since + timedelta(days=i), 0))
            for i in range(days)
        ],
        totals={k.value: totals.get(k.value, 0) for k in StatKind},
        top_pois=top(StatKind.POI),
        top_routes=top(StatKind.ROUTE),
        top_tours=top(StatKind.TOUR),
        searches=top(StatKind.SEARCH),
        misses=top(StatKind.MISS),
        private=found.access_mode == AccessMode.PRIVATE,
    )
