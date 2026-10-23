from collections.abc import Awaitable, Callable

from httpx import AsyncClient

Register = Callable[[str], Awaitable[None]]


async def test_login_logout_flow(client: AsyncClient, register: Register) -> None:
    await register("a@example.com")
    assert (await client.get("/api/auth/me")).json()["email"] == "a@example.com"

    await client.post("/api/auth/logout")
    assert (await client.get("/api/auth/me")).status_code == 401

    bad = await client.post(
        "/api/auth/login", json={"email": "a@example.com", "password": "wrong-pass"}
    )
    assert bad.status_code == 401
    ok = await client.post(
        "/api/auth/login", json={"email": "a@example.com", "password": "password123"}
    )
    assert ok.status_code == 200


async def test_draft_optimistic_locking(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Отель"})).json()
    draft = (await client.get(f"/api/maps/{created['id']}/draft")).json()
    assert draft["version"] == 1

    document = draft["document"]
    document["venue"]["name"] = "Отель «Сокол»"
    saved = await client.put(
        f"/api/maps/{created['id']}/draft", json={"document": document, "version": 1}
    )
    assert saved.json()["version"] == 2

    stale = await client.put(
        f"/api/maps/{created['id']}/draft", json={"document": document, "version": 1}
    )
    assert stale.status_code == 409


async def test_foreign_map_is_hidden(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Чужая"})).json()
    await client.post("/api/auth/logout")

    await register("intruder@example.com")
    assert (await client.get(f"/api/maps/{created['id']}/draft")).status_code == 404
    assert (await client.post(f"/api/maps/{created['id']}/publish")).status_code == 404
    assert (await client.get("/api/maps")).json() == []


async def test_publish_creates_version(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Выставка"})).json()
    first = await client.post(f"/api/maps/{created['id']}/publish")
    second = await client.post(f"/api/maps/{created['id']}/publish")
    assert first.status_code == 200
    assert (first.json()["number"], second.json()["number"]) == (1, 2)


async def test_cross_origin_write_is_rejected(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    response = await client.post(
        "/api/maps", json={"title": "CSRF"}, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403
