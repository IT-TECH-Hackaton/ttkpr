"""Minimal sync access to the panoramas and room_scans tables (schema owned by apps/api
migrations)."""

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


# --- room scans (table room_scans, created by apps/api migrations) ----------------------------


def load_scan(scan_id: str) -> dict[str, Any]:
    with engine().connect() as conn:
        row = (
            conn.execute(
                text(
                    "SELECT id, map_id, level_id, status, camera_height_m"
                    " FROM room_scans WHERE id = :id"
                ),
                {"id": scan_id},
            )
            .mappings()
            .one()
        )
    return dict(row)


def set_scan_progress(scan_id: str, progress: int) -> None:
    with engine().begin() as conn:
        conn.execute(
            text("UPDATE room_scans SET progress = :p, updated_at = now() WHERE id = :id"),
            {"p": max(0, min(100, progress)), "id": scan_id},
        )


def mark_scan_ready(scan_id: str, result: dict[str, Any]) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE room_scans SET status = 'ready', progress = 100, error = NULL,"
                " result = CAST(:result AS jsonb), updated_at = now() WHERE id = :id"
            ),
            {"result": json.dumps(result), "id": scan_id},
        )


def mark_scan_failed(scan_id: str, error: str) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE room_scans SET status = 'failed', error = :e, updated_at = now()"
                " WHERE id = :id"
            ),
            {"e": error[:2000], "id": scan_id},
        )


# --- plan imports (table plan_imports, created by apps/api migrations) -------------------------


def load_plan_import(job_id: str) -> dict[str, Any]:
    with engine().connect() as conn:
        row = (
            conn.execute(
                text("SELECT id, map_id, source_key FROM plan_imports WHERE id = :id"),
                {"id": job_id},
            )
            .mappings()
            .one()
        )
    return dict(row)


def set_plan_import_progress(job_id: str, progress: int) -> None:
    with engine().begin() as conn:
        conn.execute(
            text("UPDATE plan_imports SET progress = :p, updated_at = now() WHERE id = :id"),
            {"p": max(0, min(100, progress)), "id": job_id},
        )


def mark_plan_import_ready(job_id: str, result: dict[str, Any]) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE plan_imports SET status = 'ready', progress = 100, error = NULL,"
                " result = CAST(:result AS jsonb), updated_at = now() WHERE id = :id"
            ),
            {"result": json.dumps(result), "id": job_id},
        )


def mark_plan_import_failed(job_id: str, error: str) -> None:
    with engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE plan_imports SET status = 'failed', error = :e, updated_at = now()"
                " WHERE id = :id"
            ),
            {"e": error[:2000], "id": job_id},
        )
