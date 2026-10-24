"""Live place statuses: organizers set them without republishing, visitors poll live.json."""

from collections.abc import Awaitable, Callable

from httpx import AsyncClient

Register = Callable[[str], Awaitable[None]]

CAFE = {
    "id": "p-cafe",
    "levelId": "l1",
    "name": "Кафе",
    "category": "food",
    "position": [37.6177, 55.7559],
}


async def _map_with_cafe(client: AsyncClient, title: str = "Живая карта") -> dict[str, str]:
    created: dict[str, str] = (await client.post("/api/maps", json={"title": title})).json()
    draft = (await client.get(f"/api/maps/{created['id']}/draft")).json()
    document = draft["document"]
    document["levels"] = [{"id": "l1", "name": "1 этаж", "ordinal": 0}]
    document["pois"] = [CAFE]
    saved = await client.put(
        f"/api/maps/{created['id']}/draft", json={"document": document, "version": 1}
    )
    assert saved.status_code == 200, saved.text
    return created


async def test_live_status_reaches_visitors_without_publishing(
    client: AsyncClient, register: Register
) -> None:
    await register("owner@example.com")
    created = await _map_with_cafe(client)
    live_url = f"/api/maps/{created['id']}/live/p-cafe"
    public_url = f"/api/public/maps/{created['slug']}/live.json"
    assert (await client.get(public_url)).status_code == 404  # not published yet

    busy = await client.put(live_url, json={"status": "busy", "note": "  очередь ~10 минут  "})
    assert busy.status_code == 200, busy.text
    assert busy.json()["poiId"] == "p-cafe" and busy.json()["note"] == "очередь ~10 минут"
    studio = (await client.get(f"/api/maps/{created['id']}/live")).json()
    assert studio["places"]["p-cafe"]["status"] == "busy"

    await client.post(f"/api/maps/{created['id']}/publish")
    await client.post("/api/auth/logout")  # a visitor
    public = await client.get(public_url)
    assert public.status_code == 200
    assert public.headers["cache-control"] == "public, max-age=15"
    body = public.json()
    assert body["places"] == {
        "p-cafe": {
            "status": "busy",
            "note": "очередь ~10 минут",
            "updatedAt": busy.json()["updatedAt"],
        }
    }
    assert body["updatedAt"] == busy.json()["updatedAt"]
    etag = public.headers["etag"]
    assert (await client.get(public_url, headers={"If-None-Match": etag})).status_code == 304

    # A change shows up on the next poll, no publishing involved.
    await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "password123"}
    )
    assert (await client.put(live_url, json={"status": "open"})).json()["note"] is None
    reopened = await client.get(public_url, headers={"If-None-Match": etag})
    assert reopened.status_code == 200 and reopened.json()["places"]["p-cafe"]["status"] == "open"
    assert (await client.delete(live_url)).status_code == 204
    assert (await client.delete(live_url)).status_code == 204  # idempotent
    cleared = (await client.get(public_url)).json()
    assert cleared == {"updatedAt": None, "places": {}}


async def test_live_status_access_and_validation(client: AsyncClient, register: Register) -> None:
    for email in ("viewer@example.com", "stranger@example.com"):
        await register(email)
        await client.post("/api/auth/logout")
    await register("owner@example.com")
    created = await _map_with_cafe(client)
    map_id = created["id"]
    await client.post(
        f"/api/maps/{map_id}/members", json={"email": "viewer@example.com", "role": "viewer"}
    )
    url = f"/api/maps/{map_id}/live/p-cafe"

    assert (await client.put(url, json={"status": "maybe"})).status_code == 422
    assert (await client.put(url, json={"status": "busy", "note": "я" * 141})).status_code == 422
    unknown = await client.put(f"/api/maps/{map_id}/live/p-nowhere", json={"status": "busy"})
    assert unknown.status_code == 404
    long_id = await client.put(f"/api/maps/{map_id}/live/{'p' * 65}", json={"status": "busy"})
    assert long_id.status_code == 422

    # A place removed from the draft but still in the published version keeps its status.
    await client.post(f"/api/maps/{map_id}/publish")
    draft = (await client.get(f"/api/maps/{map_id}/draft")).json()
    draft["document"]["pois"] = []
    await client.put(f"/api/maps/{map_id}/draft", json=draft)
    assert (await client.put(url, json={"status": "closed"})).status_code == 200

    await client.post("/api/auth/logout")
    assert (await client.put(url, json={"status": "busy"})).status_code == 401
    await client.post(
        "/api/auth/login", json={"email": "viewer@example.com", "password": "password123"}
    )
    assert (await client.put(url, json={"status": "busy"})).status_code == 403
    assert (await client.delete(url)).status_code == 403
    assert (await client.get(f"/api/maps/{map_id}/live")).status_code == 200
    await client.post("/api/auth/logout")
    await client.post(
        "/api/auth/login", json={"email": "stranger@example.com", "password": "password123"}
    )
    assert (await client.put(url, json={"status": "busy"})).status_code == 404
    assert (await client.delete(url)).status_code == 404
    assert (await client.get(f"/api/maps/{map_id}/live")).status_code == 404


async def test_live_json_of_a_private_map_is_for_members(
    client: AsyncClient, register: Register
) -> None:
    await register("owner@example.com")
    created = await _map_with_cafe(client, "Закрытая")
    await client.patch(f"/api/maps/{created['id']}", json={"accessMode": "private"})
    await client.put(f"/api/maps/{created['id']}/live/p-cafe", json={"status": "busy"})
    await client.post(f"/api/maps/{created['id']}/publish")
    url = f"/api/public/maps/{created['slug']}/live.json"
    member = await client.get(url)
    assert member.status_code == 200
    assert member.headers["cache-control"] == "private, no-cache"
    await client.post("/api/auth/logout")
    assert (await client.get(url)).status_code == 403
