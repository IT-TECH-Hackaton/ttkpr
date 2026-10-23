"""Who may do what on a map. The single place to change the role model.

| Право          | Владелец | Редактор | Съёмщик | Наблюдатель |
|----------------|:--------:|:--------:|:-------:|:-----------:|
| view           |    ✓     |    ✓     |    ✓    |      ✓      |
| capture        |    ✓     |    ✓     |    ✓    |             |
| edit           |    ✓     |    ✓     |         |             |
| publish        |    ✓     |    ✓     |         |             |
| share          |    ✓     |    ✓     |         |             |
| manage_team    |    ✓     |          |         |             |
| delete         |    ✓     |          |         |             |
"""

from enum import StrEnum

from api.models import MemberRole


class Permission(StrEnum):
    VIEW = "view"  # open the draft, see panoramas and the team
    CAPTURE = "capture"  # shoot or upload panoramas
    EDIT = "edit"  # change the plan, points, underlays, panorama placement
    PUBLISH = "publish"  # make the draft visible to visitors
    SHARE = "share"  # short link, access mode, QR codes
    MANAGE_TEAM = "manage_team"  # invite, change roles, remove members
    DELETE = "delete"  # delete the whole map


ROLE_PERMISSIONS: dict[MemberRole, frozenset[Permission]] = {
    MemberRole.OWNER: frozenset(Permission),
    MemberRole.EDITOR: frozenset(
        {Permission.VIEW, Permission.CAPTURE, Permission.EDIT, Permission.PUBLISH, Permission.SHARE}
    ),
    MemberRole.PHOTOGRAPHER: frozenset({Permission.VIEW, Permission.CAPTURE}),
    MemberRole.VIEWER: frozenset({Permission.VIEW}),
}

ROLE_RANK = {
    MemberRole.VIEWER: 0,
    MemberRole.PHOTOGRAPHER: 1,
    MemberRole.EDITOR: 2,
    MemberRole.OWNER: 3,
}


def allowed(role: MemberRole | str, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(MemberRole(role), frozenset())


def permissions_of(role: MemberRole | str) -> list[str]:
    granted = ROLE_PERMISSIONS.get(MemberRole(role), frozenset())
    return [p.value for p in Permission if p in granted]
