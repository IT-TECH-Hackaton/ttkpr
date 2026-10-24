"""What visitors read: the short-lived manifest and immutable version bundles."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select

from api import bundles
from api.access import member_map, members_only
from api.config import get_settings
from api.deps import DbSession, get_current_user
from api.http_cache import conditional_json
from api.models import Map, MapVersion
from api.schemas import PublicManifest

router = APIRouter(prefix="/api/public", tags=["public"])

IMMUTABLE = "public, max-age=31536000, immutable"


async def published_map(db: DbSession, slug: str, request: Request) -> Map:
    found = await db.scalar(select(Map).where(Map.slug == slug))
    if found is None or found.published_version_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена или не опубликована")
    if members_only(found.access_mode):
        # Only members see private maps (session cookie of the organizer's account).
        try:
            user = await get_current_user(request, db, get_settings())
            await member_map(db, found.id, user)
        except HTTPException as exc:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Карта доступна только по приглашению"
            ) from exc
    return found


@router.get(
    "/maps/{slug}/manifest.json",
    response_model=PublicManifest,
    responses={304: {"description": "Not modified (If-None-Match matched the ETag)"}},
)
async def get_manifest(slug: str, request: Request, db: DbSession) -> Response:
    """Points at the current version. Public maps: the static bundle under /media, served by
    Caddy and cached forever; members-only maps: the API route that checks the session."""
    found = await published_map(db, slug, request)
    number = await db.scalar(
        select(MapVersion.number).where(MapVersion.id == found.published_version_id)
    )
    if number is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена или не опубликована")
    static = await bundles.published_static_url(db, found, number)
    manifest = PublicManifest(
        slug=found.slug,
        title=found.title,
        version=number,
        bundle_url=static or bundles.api_url(found.slug, number),
    )
    # Revalidated on every open (cheap 304); private ones never land in shared caches.
    return conditional_json(
        request,
        manifest.model_dump(mode="json", by_alias=True),
        "private, no-cache" if members_only(found.access_mode) else "no-cache",
    )


@router.get("/maps/{slug}/v/{number}/bundle.json")
async def get_bundle(
    slug: str, number: int, request: Request, response: Response, db: DbSession
) -> dict[str, Any]:
    """Kept for members-only maps and for manifests saved (offline) before static bundles."""
    found = await published_map(db, slug, request)
    bundle = await db.scalar(
        select(MapVersion.bundle).where(MapVersion.map_id == found.id, MapVersion.number == number)
    )
    if bundle is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Версия не найдена")
    # Private bundles must not end up in shared caches.
    response.headers["Cache-Control"] = (
        "private, max-age=31536000, immutable" if members_only(found.access_mode) else IMMUTABLE
    )
    return dict(bundle)
