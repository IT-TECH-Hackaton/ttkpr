import io
import json
from collections.abc import Awaitable, Callable

import pyvips
from httpx import AsyncClient

Register = Callable[[str], Awaitable[None]]


def _jpeg(width: int = 64, height: int = 48) -> bytes:
    return bytes((pyvips.Image.black(width, height, bands=3) + 120).cast("uchar").jpegsave_buffer())


async def _new_map(client: AsyncClient, title: str = "Отель") -> dict:
    response = await client.post("/api/maps", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()


async def test_publish_serves_manifest_and_bundle(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    assert (
        await client.get(f"/api/public/maps/{created['slug']}/manifest.json")
    ).status_code == 404

    published = (await client.post(f"/api/maps/{created['id']}/publish")).json()
    manifest = await client.get(f"/api/public/maps/{created['slug']}/manifest.json")
    assert manifest.headers["cache-control"] == "no-cache"
    assert manifest.json()["version"] == published["number"] == 1

    bundle = await client.get(manifest.json()["bundleUrl"])
    assert "immutable" in bundle.headers["cache-control"]
    assert bundle.json()["venue"]["name"] == "Отель"


async def test_pretty_slug_keeps_link_after_republish(
    client: AsyncClient, register: Register
) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    renamed = await client.patch(f"/api/maps/{created['id']}", json={"slug": "hotel-sokol"})
    assert renamed.json()["slug"] == "hotel-sokol"
    await client.post(f"/api/maps/{created['id']}/publish")
    await client.post(f"/api/maps/{created['id']}/publish")
    manifest = (await client.get("/api/public/maps/hotel-sokol/manifest.json")).json()
    assert manifest["version"] == 2

    other = await _new_map(client, "Другая")
    taken = await client.patch(f"/api/maps/{other['id']}", json={"slug": "hotel-sokol"})
    assert taken.status_code == 409
    bad = await client.patch(f"/api/maps/{other['id']}", json={"slug": "Плохой адрес"})
    assert bad.status_code == 422


async def test_private_map_hidden_from_visitors(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    await client.patch(f"/api/maps/{created['id']}", json={"accessMode": "private"})
    await client.post(f"/api/maps/{created['id']}/publish")
    assert (
        await client.get(f"/api/public/maps/{created['slug']}/manifest.json")
    ).status_code == 200

    await client.post("/api/auth/logout")
    assert (
        await client.get(f"/api/public/maps/{created['slug']}/manifest.json")
    ).status_code == 403


async def test_phone_capture_with_token(
    client: AsyncClient, register: Register, enqueued: list[tuple[str, ...]]
) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    token = (await client.post(f"/api/maps/{created['id']}/capture-token")).json()["token"]
    await client.post("/api/auth/logout")  # the phone has no session, only the QR token
    headers = {"X-Capture-Token": token}

    no_token = await client.post(
        f"/api/maps/{created['id']}/panoramas",
        json={"levelId": "l1", "position": [37.6, 55.7], "frameCount": 6},
    )
    assert no_token.status_code == 401

    pano = (
        await client.post(
            f"/api/maps/{created['id']}/panoramas",
            json={"levelId": "l1", "position": [37.6, 55.7], "frameCount": 6, "fovDeg": 50},
            headers=headers,
        )
    ).json()
    meta = json.dumps({"quaternion": [1, 0, 0, 0], "width": 64, "height": 48})
    for index in range(6):
        response = await client.put(
            f"/api/panoramas/{pano['id']}/frames/{index}",
            files={"file": ("f.jpg", io.BytesIO(_jpeg()), "image/jpeg")},
            data={"meta": meta},
            headers=headers,
        )
        assert response.status_code == 200, response.text
    assert response.json()["progress"] == 100

    started = await client.post(f"/api/panoramas/{pano['id']}/stitch", headers=headers)
    assert started.json()["status"] == "processing"
    assert enqueued[-1] == ("worker.tasks.stitch_panorama", pano["id"])

    other_map_token = token.replace(created["id"].replace("-", ""), "0" * 32)
    forged = await client.get(
        f"/api/panoramas/{pano['id']}", headers={"X-Capture-Token": other_map_token}
    )
    assert forged.status_code == 401


async def test_frame_upload_rejects_non_jpeg(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    pano = (
        await client.post(
            f"/api/maps/{created['id']}/panoramas",
            json={"levelId": "l1", "position": [37.6, 55.7], "frameCount": 6},
        )
    ).json()
    response = await client.put(
        f"/api/panoramas/{pano['id']}/frames/0",
        files={"file": ("x.jpg", io.BytesIO(b"<svg onload=alert(1)>"), "image/jpeg")},
        data={"meta": json.dumps({"quaternion": [1, 0, 0, 0], "width": 64, "height": 48})},
    )
    assert response.status_code == 415


async def test_underlay_upload_and_media(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    asset = await client.post(
        f"/api/maps/{created['id']}/assets",
        files={"file": ("plan.jpg", io.BytesIO(_jpeg(800, 600)), "image/jpeg")},
    )
    assert asset.status_code == 201, asset.text
    body = asset.json()
    assert (body["width"], body["height"]) == (800, 600)
    media = await client.get(body["url"])
    assert media.status_code == 200
    assert media.content[:4] == b"RIFF"  # re-encoded to WebP
    assert media.headers["content-type"] == "image/webp"

    assert (await client.get("/media/captures/anything.jpg")).status_code == 404
    assert (await client.get("/media/maps/../../etc/passwd")).status_code == 404


async def test_visitor_events_become_organizer_stats(
    client: AsyncClient, register: Register
) -> None:
    await register("stats@example.com")
    created = (await client.post("/api/maps", json={"title": "Статистика"})).json()
    slug = created["slug"]
    # Not published yet: events are ignored.
    body = '{"events":[{"kind":"view"}]}'
    assert (await client.post(f"/api/public/maps/{slug}/events", content=body)).status_code == 204
    await client.post(f"/api/maps/{created['id']}/publish")
    events = [
        {"kind": "view"},
        {"kind": "view"},
        {"kind": "poi", "key": "p-1"},
        {"kind": "miss", "key": "  Туалет "},
        {"kind": "hack", "key": "x"},
    ]
    sent = await client.post(
        f"/api/public/maps/{slug}/events",
        content=json.dumps({"events": events}),
        headers={"Content-Type": "text/plain"},
    )
    assert sent.status_code == 204
    stats = (await client.get(f"/api/maps/{created['id']}/stats?days=7")).json()
    assert stats["totals"]["view"] == 2
    assert stats["days"][-1]["views"] == 2
    assert stats["topPois"] == [{"key": "p-1", "label": "p-1", "count": 1}]
    assert stats["misses"][0]["key"] == "туалет"
