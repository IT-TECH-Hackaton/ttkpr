"""Map team: list, add by email, change role, remove, invite links."""

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from api import invites
from api.access import member_access, member_map
from api.deps import CurrentUser, DbSession
from api.models import Map, MapMember, MemberRole, User
from api.permissions import ROLE_RANK, Permission
from api.routers.maps import get_map
from api.schemas import (
    InviteAccept,
    InviteCreate,
    InviteOut,
    MapSummary,
    MemberAdd,
    MemberOut,
    MemberUpdate,
)

router = APIRouter(tags=["team"])


async def _owners(db: DbSession, map_id: uuid.UUID) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(MapMember)
        .where(MapMember.map_id == map_id, MapMember.role == MemberRole.OWNER)
    )
    return int(count or 0)


async def _membership(db: DbSession, map_id: uuid.UUID, user_id: uuid.UUID) -> MapMember:
    member = await db.scalar(
        select(MapMember).where(MapMember.map_id == map_id, MapMember.user_id == user_id)
    )
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участник не найден")
    return member


@router.get("/api/maps/{map_id}/members", response_model=list[MemberOut])
async def list_members(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[MemberOut]:
    await member_map(db, map_id, user, Permission.VIEW)
    rows = await db.execute(
        select(User, MapMember.role)
        .join(MapMember, MapMember.user_id == User.id)
        .where(MapMember.map_id == map_id)
        .order_by(MapMember.role, User.name)
    )
    return [
        MemberOut(user_id=u.id, name=u.name, email=u.email, role=role, is_you=u.id == user.id)
        for u, role in rows
    ]


@router.post(
    "/api/maps/{map_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED
)
async def add_member(
    map_id: uuid.UUID, body: MemberAdd, db: DbSession, user: CurrentUser
) -> MemberOut:
    await member_map(db, map_id, user, Permission.MANAGE_TEAM)
    invitee = await db.scalar(select(User).where(User.email == body.email.lower()))
    if invitee is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Пользователь с таким email не зарегистрирован — отправьте ему ссылку-приглашение",
        )
    exists = await db.scalar(
        select(MapMember.id).where(MapMember.map_id == map_id, MapMember.user_id == invitee.id)
    )
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Этот человек уже в команде")
    db.add(MapMember(map_id=map_id, user_id=invitee.id, role=body.role))
    await db.commit()
    return MemberOut(
        user_id=invitee.id, name=invitee.name, email=invitee.email, role=body.role, is_you=False
    )


@router.patch("/api/maps/{map_id}/members/{user_id}", response_model=MemberOut)
async def update_member(
    map_id: uuid.UUID, user_id: uuid.UUID, body: MemberUpdate, db: DbSession, user: CurrentUser
) -> MemberOut:
    await member_map(db, map_id, user, Permission.MANAGE_TEAM)
    member = await _membership(db, map_id, user_id)
    if (
        member.role == MemberRole.OWNER
        and body.role != MemberRole.OWNER
        and await _owners(db, map_id) == 1
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "У карты должен остаться хотя бы один владелец"
        )
    member.role = body.role
    await db.commit()
    target = await db.get(User, user_id)
    assert target is not None
    return MemberOut(
        user_id=target.id,
        name=target.name,
        email=target.email,
        role=body.role,
        is_you=target.id == user.id,
    )


@router.delete("/api/maps/{map_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    map_id: uuid.UUID, user_id: uuid.UUID, db: DbSession, user: CurrentUser
) -> None:
    """Owners remove anyone; every member may leave on their own."""
    if user_id != user.id:
        await member_map(db, map_id, user, Permission.MANAGE_TEAM)
    else:
        await member_access(db, map_id, user)
    member = await _membership(db, map_id, user_id)
    if member.role == MemberRole.OWNER and await _owners(db, map_id) == 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Это единственный владелец: назначьте другого владельца или удалите карту",
        )
    await db.delete(member)
    await db.commit()


@router.post("/api/maps/{map_id}/invites", response_model=InviteOut)
async def create_invite(
    map_id: uuid.UUID, body: InviteCreate, db: DbSession, user: CurrentUser
) -> InviteOut:
    await member_map(db, map_id, user, Permission.MANAGE_TEAM)
    if body.role == MemberRole.OWNER:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Владельцем можно сделать только участника команды",
        )
    token, expires = invites.issue(map_id, body.role)
    return InviteOut(token=token, role=body.role, expires_at=expires)


@router.post("/api/invites/accept", response_model=MapSummary)
async def accept_invite(body: InviteAccept, db: DbSession, user: CurrentUser) -> MapSummary:
    parsed = invites.verify(body.token)
    if parsed is None:
        raise HTTPException(status.HTTP_410_GONE, "Приглашение недействительно или устарело")
    map_id, role = parsed
    found = await db.get(Map, map_id)
    if found is None:
        raise HTTPException(status.HTTP_410_GONE, "Карта уже удалена")
    member = await db.scalar(
        select(MapMember).where(MapMember.map_id == map_id, MapMember.user_id == user.id)
    )
    if member is None:
        db.add(MapMember(map_id=map_id, user_id=user.id, role=role))
    elif ROLE_RANK[role] > ROLE_RANK[MemberRole(member.role)]:
        member.role = role  # an invite never lowers an existing role
    await db.commit()
    return await get_map(map_id, db, user)
