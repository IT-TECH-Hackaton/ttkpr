"""What visitors read: the short-lived manifest and immutable version bundles."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select

from api.access import member_map
from api.config import get_settings
from api.deps import DbSession, get_current_user
from api.models import AccessMode, Map, MapVersion
from api.schemas import PublicManifest

router = APIRouter(prefix="/api/public", tags=["public"])

IMMUTABLE = "public, max-age=31536000, immutable"


async def _published(db: DbSession, slug: str, request: Request) -> Map:
    found = await db.scalar(select(Map).where(Map.slug == slug))
    if found is None or found.published_version_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена или не опубликована")
    if found.access_mode == AccessMode.PRIVATE:
        # Only members see private maps (session cookie of the organizer's account).
        try:
            user = await get_current_user(request, db, get_settings())
            await member_map(db, found.id, user)
        except HTTPException as exc:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Карта доступна только по приглашению"
            ) from exc
    return found


@router.get("/maps/{slug}/manifest.json", response_model=PublicManifest)
async def get_manifest(
    slug: str, request: Request, response: Response, db: DbSession
) -> PublicManifest:
    found = await _published(db, slug, request)
    number = await db.scalar(
        select(MapVersion.number).where(MapVersion.id == found.published_version_id)
    )
    response.headers["Cache-Control"] = "no-cache"
    return PublicManifest(
        slug=found.slug,
        title=found.title,
        version=number or 0,
        bundle_url=f"/api/public/maps/{found.slug}/v/{number}/bundle.json",
    )


@router.get("/maps/{slug}/v/{number}/bundle.json")
async def get_bundle(
    slug: str, number: int, request: Request, response: Response, db: DbSession
) -> dict[str, Any]:
    found = await _published(db, slug, request)
    bundle = await db.scalar(
        select(MapVersion.bundle).where(MapVersion.map_id == found.id, MapVersion.number == number)
    )
    if bundle is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Версия не найдена")
    # Private bundles must not end up in shared caches.
    response.headers["Cache-Control"] = (
        "private, max-age=31536000, immutable"
        if found.access_mode == AccessMode.PRIVATE
        else IMMUTABLE
    )
    return dict(bundle)
