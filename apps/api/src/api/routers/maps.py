import shutil
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select, update

from api import bundles, capture_tokens
from api.access import member_access, member_map, members_only
from api.deps import CurrentUser, DbSession
from api.models import (
    AccessMode,
    Map,
    MapMember,
    MapVersion,
    MemberRole,
    Panorama,
    PanoramaStatus,
    RoomScan,
    VersionStatus,
)
from api.permissions import Permission, permissions_of
from api.schemas import (
    AssetOut,
    CaptureTokenOut,
    DraftOut,
    DraftSave,
    MapCreate,
    MapSummary,
    MapUpdate,
    PublishOut,
    VersionOut,
)
from api.security import hash_password
from api.slugs import RESERVED, free_slug
from api.storage import get_storage
from api.uploads import ensure_image, read_limited, reencode_webp
from map_schema.models import MapDocument, Pano, PanoStatus, PanoTiles, Venue

router = APIRouter(prefix="/api/maps", tags=["maps"])


def _with_role(summary: MapSummary, role: MemberRole) -> MapSummary:
    summary.role = role
    summary.permissions = permissions_of(role)
    return summary


async def _summary(db: DbSession, found: Map, role: MemberRole) -> MapSummary:
    number = None
    if found.published_version_id:
        number = await db.scalar(
            select(MapVersion.number).where(MapVersion.id == found.published_version_id)
        )
    summary = MapSummary.model_validate(found)
    summary.has_password = found.access_password_hash is not None
    summary.published_number = number
    return _with_role(summary, role)


@router.get("", response_model=list[MapSummary])
async def list_maps(db: DbSession, user: CurrentUser) -> list[MapSummary]:
    rows = await db.execute(
        select(Map, MapVersion.number, MapMember.role)
        .join(MapMember, MapMember.map_id == Map.id)
        .outerjoin(MapVersion, MapVersion.id == Map.published_version_id)
        .where(MapMember.user_id == user.id)
        .order_by(Map.updated_at.desc())
    )
    result = []
    for found, number, role in rows:
        summary = MapSummary.model_validate(found)
        summary.has_password = found.access_password_hash is not None
        summary.published_number = number
        result.append(_with_role(summary, MemberRole(role)))
    return result


@router.post("", response_model=MapSummary, status_code=status.HTTP_201_CREATED)
async def create_map(body: MapCreate, db: DbSession, user: CurrentUser) -> MapSummary:
    slug = await free_slug(db, body.title)
    document = MapDocument(venue=Venue(id=slug, name=body.title, anchor=body.anchor))
    new_map = Map(
        slug=slug, title=body.title, draft=document.model_dump(mode="json", by_alias=True)
    )
    db.add(new_map)
    await db.flush()
    db.add(MapMember(map_id=new_map.id, user_id=user.id, role=MemberRole.OWNER))
    await db.commit()
    return await _summary(db, new_map, MemberRole.OWNER)


@router.get("/{map_id}", response_model=MapSummary)
async def get_map(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> MapSummary:
    found, role = await member_access(db, map_id, user)
    return await _summary(db, found, role)


@router.patch("/{map_id}", response_model=MapSummary)
async def update_map(
    map_id: uuid.UUID, body: MapUpdate, db: DbSession, user: CurrentUser
) -> MapSummary:
    # Title is part of editing; the public link and who sees the map are sharing decisions.
    sharing = (
        (body.slug is not None and body.slug != "")
        or body.access_mode is not None
        or body.access_password is not None
    )
    found = await member_map(db, map_id, user, Permission.SHARE if sharing else Permission.EDIT)
    _, role = await member_access(db, map_id, user)
    mode_changes = body.access_mode is not None and body.access_mode != found.access_mode
    if mode_changes:
        # Same lock as publishing and the manifest's lazy write of static bundles.
        await db.refresh(found, with_for_update=True)
    if body.access_password:
        # After the lock's re-read; a new password locks out everyone who unlocked with the
        # old one (see access.map_key).
        found.access_password_hash = hash_password(body.access_password)
    if body.access_mode == AccessMode.PASSWORD and not found.access_password_hash:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Задайте пароль для карты")
    if body.slug and body.slug != found.slug:
        if body.slug in RESERVED or await db.scalar(select(Map.id).where(Map.slug == body.slug)):
            raise HTTPException(status.HTTP_409_CONFLICT, "Такой адрес уже занят")
        found.slug = body.slug
    if body.title:
        found.title = body.title
    if body.access_mode and mode_changes:
        found.access_mode = body.access_mode
        if members_only(body.access_mode):
            # Before commit, under the lock: nobody re-reads the old mode and writes it back.
            # Copies a CDN already cached expire only with the CDN (see ARCHITECTURE.md).
            await run_in_threadpool(bundles.remove_static, map_id)
        elif found.published_version_id:
            version = await db.get(MapVersion, found.published_version_id)
            if version and version.bundle is not None:
                await bundles.write_static(map_id, version.number, version.bundle)
    await db.commit()
    return await _summary(db, found, role)


@router.delete("/{map_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_map(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> None:
    found = await member_map(db, map_id, user, Permission.DELETE)
    pano_ids = list(await db.scalars(select(Panorama.id).where(Panorama.map_id == map_id)))
    scan_ids = list(await db.scalars(select(RoomScan.id).where(RoomScan.map_id == map_id)))
    await db.delete(found)
    await db.commit()
    storage = get_storage()
    for prefix in [
        f"maps/{map_id}",
        *(f"panos/{p}" for p in pano_ids),
        *(f"captures/{p}" for p in pano_ids),
        *(f"scans/{s}" for s in scan_ids),
    ]:
        shutil.rmtree(storage.path(prefix), ignore_errors=True)


@router.get("/{map_id}/draft", response_model=DraftOut)
async def get_draft(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> DraftOut:
    found = await member_map(db, map_id, user)
    return DraftOut(document=MapDocument.model_validate(found.draft), version=found.draft_version)


@router.put("/{map_id}/draft", response_model=DraftOut)
async def save_draft(
    map_id: uuid.UUID, body: DraftSave, db: DbSession, user: CurrentUser
) -> DraftOut:
    await member_map(db, map_id, user, Permission.EDIT)
    # Panoramas are a separate resource; they join the document only at publish time.
    document = body.document.model_copy(update={"panos": []})
    result = await db.execute(
        update(Map)
        .where(Map.id == map_id, Map.draft_version == body.version)
        .values(
            draft=document.model_dump(mode="json", by_alias=True),
            draft_version=Map.draft_version + 1,
        )
        .returning(Map.draft_version)
    )
    new_version = result.scalar_one_or_none()
    if new_version is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Карту уже изменили — обновите черновик")
    await db.commit()
    return DraftOut(document=document, version=new_version)


def bundle_pano(pano: Panorama) -> Pano:
    return Pano(
        id=str(pano.id),
        level_id=pano.level_id,
        position=(pano.lon, pano.lat),
        heading_deg=pano.heading_deg,
        camera_height_m=pano.camera_height_m,
        status=PanoStatus.READY,
        tiles=PanoTiles.model_validate(pano.tiles),
    )


@router.post("/{map_id}/publish", response_model=PublishOut)
async def publish(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> PublishOut:
    """Freezes draft + ready panoramas into a new immutable version; the link stays the same."""
    found = await member_map(db, map_id, user, Permission.PUBLISH)
    # One publish at a time per map; also re-reads the draft and the access mode under the lock.
    await db.refresh(found, with_for_update=True)
    panoramas = await db.scalars(
        select(Panorama).where(Panorama.map_id == map_id, Panorama.status == PanoramaStatus.READY)
    )
    document = MapDocument.model_validate(found.draft).model_copy(
        update={"panos": [bundle_pano(p) for p in panoramas if p.tiles]}
    )
    bundle: dict[str, Any] = document.model_dump(mode="json", by_alias=True)
    last = await db.scalar(select(func.max(MapVersion.number)).where(MapVersion.map_id == map_id))
    version = MapVersion(
        map_id=map_id, number=(last or 0) + 1, status=VersionStatus.READY, bundle=bundle
    )
    db.add(version)
    await db.flush()
    if not members_only(found.access_mode):
        # Visitors then read a static file (Caddy, CDN); written before the pointer moves.
        await bundles.write_static(map_id, version.number, bundle)
    found.published_version_id = version.id
    await db.commit()
    return PublishOut(
        version_id=version.id, number=version.number, status=version.status, slug=found.slug
    )


@router.get("/{map_id}/versions", response_model=list[VersionOut])
async def list_versions(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[VersionOut]:
    """Published versions, newest first; one of them may be the one visitors see."""
    found = await member_map(db, map_id, user, Permission.VIEW)
    rows = await db.execute(
        select(MapVersion.id, MapVersion.number, MapVersion.created_at)
        .where(MapVersion.map_id == map_id, MapVersion.status == VersionStatus.READY)
        .order_by(MapVersion.number.desc())
        .limit(50)
    )
    return [
        VersionOut(number=n, created_at=at, published=vid == found.published_version_id)
        for vid, n, at in rows
    ]


@router.post("/{map_id}/versions/{number}/publish", response_model=PublishOut)
async def republish_version(
    map_id: uuid.UUID, number: int, db: DbSession, user: CurrentUser
) -> PublishOut:
    """Back to an earlier version: visitors see it again, the link stays; the draft is untouched."""
    found = await member_map(db, map_id, user, Permission.PUBLISH)
    await db.refresh(found, with_for_update=True)
    version = await db.scalar(
        select(MapVersion).where(MapVersion.map_id == map_id, MapVersion.number == number)
    )
    if version is None or version.bundle is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Версия не найдена")
    if not members_only(found.access_mode):
        await bundles.write_static(map_id, version.number, version.bundle)
    found.published_version_id = version.id
    await db.commit()
    return PublishOut(
        version_id=version.id, number=version.number, status=version.status, slug=found.slug
    )


@router.post("/{map_id}/unpublish", status_code=status.HTTP_204_NO_CONTENT)
async def unpublish(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> None:
    """Visitors get "not published" again; versions are kept and can be published back."""
    found = await member_map(db, map_id, user, Permission.PUBLISH)
    await db.refresh(found, with_for_update=True)
    found.published_version_id = None
    await run_in_threadpool(bundles.remove_static, map_id)
    await db.commit()


@router.post("/{map_id}/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    map_id: uuid.UUID, file: UploadFile, db: DbSession, user: CurrentUser
) -> AssetOut:
    """Plan image for the underlay. Re-encoded to WebP <= 4096 px without metadata."""
    await member_map(db, map_id, user, Permission.EDIT)
    data = await read_limited(file)
    ensure_image(data)
    webp, width, height = await run_in_threadpool(reencode_webp, data)
    url = get_storage().put(f"maps/{map_id}/assets/{uuid.uuid4()}.webp", webp)
    return AssetOut(url=url, width=width, height=height)


@router.post("/{map_id}/capture-token", response_model=CaptureTokenOut)
async def create_capture_token(
    map_id: uuid.UUID, db: DbSession, user: CurrentUser
) -> CaptureTokenOut:
    """Token for the QR code: a phone can shoot panoramas for this map without logging in."""
    await member_map(db, map_id, user, Permission.CAPTURE)
    token, expires = capture_tokens.issue(map_id, user.id)
    return CaptureTokenOut(token=token, expires_at=expires)
