import uuid

from fastapi import HTTPException, Request, status
from sqlalchemy import select

from api import capture_tokens
from api.config import get_settings
from api.deps import DbSession, get_current_user
from api.models import AccessMode, Map, MapMember, MemberRole, User
from api.permissions import Permission, allowed


def members_only(mode: str) -> bool:
    """Private maps, and "password" ones until passwords exist: fail closed, never public."""
    return mode in (AccessMode.PRIVATE, AccessMode.PASSWORD)


async def member_access(db: DbSession, map_id: uuid.UUID, user: User) -> tuple[Map, MemberRole]:
    """No membership -> 404, so map ids do not leak to strangers."""
    row = (
        await db.execute(
            select(Map, MapMember.role)
            .join(MapMember, MapMember.map_id == Map.id)
            .where(Map.id == map_id, MapMember.user_id == user.id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Карта не найдена")
    return row[0], MemberRole(row[1])


async def member_map(
    db: DbSession, map_id: uuid.UUID, user: User, need: Permission = Permission.VIEW
) -> Map:
    """Every organizer route goes through here with the permission it requires."""
    found, role = await member_access(db, map_id, user)
    if not allowed(role, need):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав для этого действия")
    return found


async def capture_map(
    request: Request, db: DbSession, map_id: uuid.UUID, need: Permission = Permission.CAPTURE
) -> Map:
    """Organizer session or a capture token (QR on the phone) for this exact map.

    The token acts on behalf of the user who issued it, with that user's current role:
    removing someone from the team also revokes their QR links.
    """
    token = request.headers.get("x-capture-token")
    if not token:
        user = await get_current_user(request, db, get_settings())
        return await member_map(db, map_id, user, need)
    user_id = capture_tokens.verify(token, map_id)
    issuer = await db.get(User, user_id) if user_id else None
    if issuer is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Ссылка для съёмки устарела")
    return await member_map(db, map_id, issuer, need)
