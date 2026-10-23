"""Role model end to end: what each role may and may not do, team management, invites, profile."""

from collections.abc import Awaitable, Callable

import pytest
from httpx import AsyncClient

Register = Callable[[str], Awaitable[None]]


async def _switch(client: AsyncClient, email: str) -> None:
    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, r.text


async def _team_map(client: AsyncClient, register: Register) -> str:
    """Owner creates a map and adds editor/photographer/viewer; returns the map id."""
    for email in ("editor@example.com", "photo@example.com", "viewer@example.com"):
        await register(email)
        await client.post("/api/auth/logout")
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Команда"})).json()["id"]
    for email, role in (
        ("editor@example.com", "editor"),
        ("photo@example.com", "photographer"),
        ("viewer@example.com", "viewer"),
    ):
        r = await client.post(f"/api/maps/{map_id}/members", json={"email": email, "role": role})
        assert r.status_code == 201, r.text
    return map_id


@pytest.mark.parametrize(
    ("email", "can_edit", "can_publish", "can_capture", "can_share", "can_manage"),
    [
        ("editor@example.com", True, True, True, True, False),
        ("photo@example.com", False, False, True, False, False),
        ("viewer@example.com", False, False, False, False, False),
    ],
)
async def test_permission_matrix(
    client: AsyncClient,
    register: Register,
    email: str,
    can_edit: bool,
    can_publish: bool,
    can_capture: bool,
    can_share: bool,
    can_manage: bool,
) -> None:
    map_id = await _team_map(client, register)
    await _switch(client, email)
    expect = lambda ok: 200 if ok else 403  # noqa: E731

    summary = (await client.get(f"/api/maps/{map_id}")).json()
    assert ("edit" in summary["permissions"]) is can_edit

    draft = (await client.get(f"/api/maps/{map_id}/draft")).json()  # everyone may view
    saved = await client.put(f"/api/maps/{map_id}/draft", json=draft)
    assert saved.status_code == expect(can_edit)
    assert (await client.post(f"/api/maps/{map_id}/publish")).status_code == expect(can_publish)
    token = await client.post(f"/api/maps/{map_id}/capture-token")
    assert token.status_code == expect(can_capture)
    share = await client.patch(f"/api/maps/{map_id}", json={"accessMode": "public"})
    assert share.status_code == expect(can_share)
    invite = await client.post(f"/api/maps/{map_id}/invites", json={"role": "viewer"})
    assert invite.status_code == expect(can_manage)
    assert (await client.delete(f"/api/maps/{map_id}")).status_code == (
        403 if not can_manage else 204
    )


async def test_last_owner_is_protected(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    me = (await client.get("/api/auth/me")).json()
    map_id = (await client.post("/api/maps", json={"title": "Одна"})).json()["id"]
    demote = await client.patch(f"/api/maps/{map_id}/members/{me['id']}", json={"role": "editor"})
    assert demote.status_code == 409
    assert (await client.delete(f"/api/maps/{map_id}/members/{me['id']}")).status_code == 409


async def test_invite_link_joins_with_role_and_never_downgrades(
    client: AsyncClient, register: Register
) -> None:
    await register("guest@example.com")
    await client.post("/api/auth/logout")
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Инвайт"})).json()["id"]
    photo = (await client.post(f"/api/maps/{map_id}/invites", json={"role": "photographer"})).json()
    viewer = (await client.post(f"/api/maps/{map_id}/invites", json={"role": "viewer"})).json()
    owner_invite = await client.post(f"/api/maps/{map_id}/invites", json={"role": "owner"})
    assert owner_invite.status_code == 422

    await _switch(client, "guest@example.com")
    joined = await client.post("/api/invites/accept", json={"token": photo["token"]})
    assert joined.json()["role"] == "photographer"
    again = await client.post("/api/invites/accept", json={"token": viewer["token"]})
    assert again.json()["role"] == "photographer"
    forged = photo["token"].replace("photographer", "editor")
    assert (await client.post("/api/invites/accept", json={"token": forged})).status_code == 410

    left = await client.delete(
        f"/api/maps/{map_id}/members/{(await client.get('/api/auth/me')).json()['id']}"
    )
    assert left.status_code == 204
    assert (await client.get(f"/api/maps/{map_id}")).status_code == 404


async def test_removed_member_loses_capture_link(client: AsyncClient, register: Register) -> None:
    map_id = await _team_map(client, register)
    await _switch(client, "photo@example.com")
    token = (await client.post(f"/api/maps/{map_id}/capture-token")).json()["token"]
    photo_id = (await client.get("/api/auth/me")).json()["id"]
    await _switch(client, "owner@example.com")
    await client.delete(f"/api/maps/{map_id}/members/{photo_id}")
    await client.post("/api/auth/logout")
    response = await client.post(
        f"/api/maps/{map_id}/panoramas",
        json={"levelId": "l1", "position": [37.6, 55.7], "frameCount": 6},
        headers={"X-Capture-Token": token},
    )
    assert response.status_code == 404


async def test_profile_and_password(client: AsyncClient, register: Register) -> None:
    await register("me@example.com")
    renamed = await client.patch("/api/auth/me", json={"name": "Организатор"})
    assert renamed.json()["name"] == "Организатор"
    wrong = await client.post(
        "/api/auth/password", json={"currentPassword": "nope", "newPassword": "new-password-1"}
    )
    assert wrong.status_code == 400
    ok = await client.post(
        "/api/auth/password",
        json={"currentPassword": "password123", "newPassword": "new-password-1"},
    )
    assert ok.status_code == 204
    assert (await client.get("/api/auth/me")).status_code == 200  # this device stays signed in
    await client.post("/api/auth/logout-all")
    assert (await client.get("/api/auth/me")).status_code == 401
    relogin = await client.post(
        "/api/auth/login", json={"email": "me@example.com", "password": "new-password-1"}
    )
    assert relogin.status_code == 200
