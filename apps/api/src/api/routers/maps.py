import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select, update

from api import queue
from api.deps import CurrentUser, DbSession
from api.models import Map, MapMember, MapVersion, MemberRole
from api.schemas import DraftOut, DraftSave, MapCreate, MapSummary, PublishOut
from api.security import new_slug
from map_schema.models import MapDocument, Venue

router = APIRouter(prefix="/api/maps", tags=["maps"])


async def _get_member_map(db: DbSession, map_id: uuid.UUID, user: CurrentUser) -> Map:
    """Every map route goes through here: no membership -> 404, so map ids do not leak."""
    found = await db.scalar(
        select(Map)
        .join(MapMember, MapMember.map_id == Map.id)
        .where(Map.id == map_id, MapMember.user_id == user.id)
    )
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена")
    return found


@router.get("", response_model=list[MapSummary])
async def list_maps(db: DbSession, user: CurrentUser) -> list[Map]:
    rows = await db.scalars(
        select(Map)
        .join(MapMember, MapMember.map_id == Map.id)
        .where(MapMember.user_id == user.id)
        .order_by(Map.updated_at.desc())
    )
    return list(rows)


@router.post("", response_model=MapSummary, status_code=status.HTTP_201_CREATED)
async def create_map(body: MapCreate, db: DbSession, user: CurrentUser) -> Map:
    slug = new_slug()
    document = MapDocument(venue=Venue(id=slug, name=body.title, anchor=body.anchor))
    new_map = Map(
        slug=slug, title=body.title, draft=document.model_dump(mode="json", by_alias=True)
    )
    db.add(new_map)
    await db.flush()
    db.add(MapMember(map_id=new_map.id, user_id=user.id, role=MemberRole.OWNER))
    await db.commit()
    return new_map


@router.get("/{map_id}/draft", response_model=DraftOut)
async def get_draft(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> DraftOut:
    found = await _get_member_map(db, map_id, user)
    return DraftOut(document=MapDocument.model_validate(found.draft), version=found.draft_version)


@router.put("/{map_id}/draft", response_model=DraftOut)
async def save_draft(
    map_id: uuid.UUID, body: DraftSave, db: DbSession, user: CurrentUser
) -> DraftOut:
    await _get_member_map(db, map_id, user)
    result = await db.execute(
        update(Map)
        .where(Map.id == map_id, Map.draft_version == body.version)
        .values(
            draft=body.document.model_dump(mode="json", by_alias=True),
            draft_version=Map.draft_version + 1,
        )
        .returning(Map.draft_version)
    )
    new_version = result.scalar_one_or_none()
    if new_version is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Карту уже изменили — обновите черновик")
    await db.commit()
    return DraftOut(document=body.document, version=new_version)


@router.post("/{map_id}/publish", response_model=PublishOut, status_code=status.HTTP_202_ACCEPTED)
async def publish(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> PublishOut:
    await _get_member_map(db, map_id, user)
    last = await db.scalar(select(func.max(MapVersion.number)).where(MapVersion.map_id == map_id))
    version = MapVersion(map_id=map_id, number=(last or 0) + 1)
    db.add(version)
    await db.commit()
    queue.enqueue("worker.tasks.build_map_version", str(map_id), str(version.id))
    return PublishOut(version_id=version.id, number=version.number, status=version.status)
