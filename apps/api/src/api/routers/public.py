"""What visitors read: the short-lived manifest and immutable version bundles."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import select

from api import bundles, ratelimit
from api.access import map_key, map_key_cookie, member_map, members_only, unlocked
from api.config import get_settings
from api.deps import DbSession, get_current_user
from api.http_cache import conditional_json
from api.models import AccessMode, Map, MapVersion, Panorama, PanoramaStatus
from api.routers.maps import bundle_pano
from api.schemas import MapUnlock, PublicManifest
from api.security import verify_password
from map_schema.models import MapDocument

router = APIRouter(prefix="/api/public", tags=["public"])

IMMUTABLE = "public, max-age=31536000, immutable"


async def published_map(db: DbSession, slug: str, request: Request) -> Map:
    found = await db.scalar(select(Map).where(Map.slug == slug))
    if found is None or found.published_version_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена или не опубликована")
    if found.access_mode == AccessMode.PASSWORD and unlocked(request, found):
        return found
    if members_only(found.access_mode):
        # Only members see private maps (session cookie of the organizer's account).
        try:
            user = await get_current_user(request, db, get_settings())
            await member_map(db, found.id, user)
        except HTTPException as exc:
            if found.access_mode == AccessMode.PASSWORD:
                # The visitor app shows the password form on 401.
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужен пароль") from exc
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Карта доступна только по приглашению"
            ) from exc
    return found


@router.post("/maps/{slug}/unlock", status_code=status.HTTP_204_NO_CONTENT)
async def unlock_map(slug: str, body: MapUnlock, request: Request, db: DbSession) -> Response:
    """A password map: the right password sets a cookie that opens this map for 30 days."""
    await ratelimit.limit(request, "unlock", max_hits=10, window_s=300, subject=slug)
    found = await db.scalar(select(Map).where(Map.slug == slug))
    if (
        found is None
        or found.access_mode != AccessMode.PASSWORD
        or not found.access_password_hash
        or not verify_password(found.access_password_hash, body.password)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Неверный пароль")
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.set_cookie(
        map_key_cookie(found.id),
        map_key(found),
        max_age=30 * 24 * 3600,
        httponly=True,
        secure=get_settings().cookie_secure,
        samesite="lax",
        path="/api/public/maps",
    )
    return response


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


@router.get("/maps/{slug}/draft.json")
async def get_draft_bundle(slug: str, request: Request, db: DbSession) -> Response:
    """Studio preview: the current draft with ready panoramas, as visitors would see it after
    publishing. Team members only; strangers get 404, so drafts of other maps do not leak."""
    found = await db.scalar(select(Map).where(Map.slug == slug))
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена")
    try:
        user = await get_current_user(request, db, get_settings())
        await member_map(db, found.id, user)
    except HTTPException as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена") from exc
    panoramas = await db.scalars(
        select(Panorama).where(Panorama.map_id == found.id, Panorama.status == PanoramaStatus.READY)
    )
    document = MapDocument.model_validate(found.draft).model_copy(
        update={"panos": [bundle_pano(p) for p in panoramas if p.tiles]}
    )
    return JSONResponse(
        document.model_dump(mode="json", by_alias=True),
        headers={"Cache-Control": "private, no-store"},
    )
