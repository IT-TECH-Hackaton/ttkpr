"""Minimal sync access to the panoramas table (schema owned by apps/api migrations)."""

import json
from functools import lru_cache
from typing import Any

from sqlalchemy import Engine, create_engine, text

from worker.config import DATABASE_URL


@lru_cache
def engine() -> Engine:
    return create_engine(DATABASE_URL, pool_pre_ping=True)


def load_panorama(pano_id: str) -> dict[str, Any]:
    with engine().connect() as conn:
        row = (
            conn.execute(
                text("SELECT id, capture_meta, source FROM panoramas WHERE id = :id"),
                {"id": pano_id},
            )
            .mappings()
            .one()
        )
    return dict(row)


def set_progress(pano_id: str, progress: int) -> None:
    with engine().begin() as conn:
        conn.execute(
            text("UPDATE panoramas SET progress = :p, updated_at = now() WHERE id = :id"),
            {"p": max(0, min(100, progress)), "id": pano_id},
        )


def mark_ready(pano_id: str, tiles: dict[str, Any], quality: dict[str, Any] | None) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE panoramas SET status = 'ready', progress = 100, error = NULL,"
                " tiles = CAST(:tiles AS jsonb), quality = CAST(:quality AS jsonb),"
                " updated_at = now() WHERE id = :id"
            ),
            {"tiles": json.dumps(tiles), "quality": json.dumps(quality), "id": pano_id},
        )


def mark_failed(pano_id: str, error: str) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE panoramas SET status = 'failed', error = :e, updated_at = now()"
                " WHERE id = :id"
            ),
            {"e": error[:2000], "id": pano_id},
        )
