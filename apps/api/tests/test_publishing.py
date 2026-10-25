import asyncio
import gzip
import io
import json
import shutil
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import pyvips
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.models import AccessMode, Map

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


async def test_public_bundle_is_a_static_file(
    client: AsyncClient, register: Register, tmp_path: Path
) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    await client.post(f"/api/maps/{created['id']}/publish")
    manifest = (await client.get(f"/api/public/maps/{created['slug']}/manifest.json")).json()
    # Keyed by map id: a slug re-used by another map can never hit this cached copy.
    assert manifest["bundleUrl"] == f"/media/maps/{created['id']}/v/1/bundle.json"
    static = await client.get(manifest["bundleUrl"])
    assert static.status_code == 200
    assert static.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert static.json()["venue"]["name"] == "Отель"
    stored = tmp_path / "storage" / "maps" / created["id"] / "v" / "1"
    assert gzip.decompress((stored / "bundle.json.gz").read_bytes()) == static.content
    # Old manifests (offline copies) keep working through the API route.
    old = await client.get(f"/api/public/maps/{created['slug']}/v/1/bundle.json")
    assert old.json() == static.json()

    # Published before static bundles existed: the first manifest request writes the file.
    shutil.rmtree(stored)
    again = (await client.get(f"/api/public/maps/{created['slug']}/manifest.json")).json()
    assert again["bundleUrl"] == manifest["bundleUrl"] and (stored / "bundle.json").is_file()


async def test_manifest_etag_and_304(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    await client.post(f"/api/maps/{created['id']}/publish")
    url = f"/api/public/maps/{created['slug']}/manifest.json"
    first = await client.get(url)
    etag = first.headers["etag"]
    assert etag.startswith('"') and first.headers["cache-control"] == "no-cache"
    for header in (etag, f"W/{etag}", etag[:-1] + '-gzip"', f'"other", {etag}'):
        cached = await client.get(url, headers={"If-None-Match": header})
        assert cached.status_code == 304, header
        assert cached.content == b"" and cached.headers["etag"] == etag
    await client.post(f"/api/maps/{created['id']}/publish")
    fresh = await client.get(url, headers={"If-None-Match": etag})
    assert fresh.status_code == 200 and fresh.json()["version"] == 2
    assert fresh.headers["etag"] != etag


async def test_members_only_maps_get_no_static_bundle(
    client: AsyncClient, register: Register, tmp_path: Path
) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    versions = tmp_path / "storage" / "maps" / created["id"] / "v"
    url = f"/api/public/maps/{created['slug']}/manifest.json"
    await client.post(f"/api/maps/{created['id']}/publish")
    assert (versions / "1" / "bundle.json").is_file()

    # Going private removes every published file right away.
    await client.patch(f"/api/maps/{created['id']}", json={"accessMode": "private"})
    assert not versions.exists()
    await client.post(f"/api/maps/{created['id']}/publish")
    assert not versions.exists()
    private = await client.get(url)
    assert private.json()["bundleUrl"] == f"/api/public/maps/{created['slug']}/v/2/bundle.json"
    assert private.headers["cache-control"] == "private, no-cache"
    assert (await client.get(private.json()["bundleUrl"])).status_code == 200  # the owner

    # Back to "by link": the current version is static again.
    await client.patch(f"/api/maps/{created['id']}", json={"accessMode": "link"})
    assert (versions / "2" / "bundle.json").is_file()
    assert (await client.get(url)).json()["bundleUrl"].startswith("/media/maps/")


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


async def test_password_mode_needs_a_password_and_is_never_public(
    client: AsyncClient, register: Register, db_sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    await register("owner@example.com")
    created = await _new_map(client)
    refused = await client.patch(f"/api/maps/{created['id']}", json={"accessMode": "password"})
    assert refused.status_code == 422
    assert "пароль" in refused.json()["detail"]
    assert (await client.get(f"/api/maps/{created['id']}")).json()["accessMode"] == "link"

    # A map stored as "password" without one: members only, never a static file.
    await client.post(f"/api/maps/{created['id']}/publish")
    async with db_sessionmaker() as db:
        await db.execute(
            update(Map)
            .where(Map.id == uuid.UUID(created["id"]))
            .values(access_mode=AccessMode.PASSWORD)
        )
        await db.commit()
    manifest = f"/api/public/maps/{created['slug']}/manifest.json"
    assert (await client.get(manifest)).status_code == 200  # the owner
    await client.post("/api/auth/logout")
    assert (await client.get(manifest)).status_code == 401
    assert (
        await client.get(f"/api/public/maps/{created['slug']}/v/1/bundle.json")
    ).status_code == 401


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


async def test_parallel_frame_uploads_keep_every_frame(
    client: AsyncClient, register: Register
) -> None:
    """The phone uploads frames in parallel; none may be lost to a read-modify-write race."""
    await register("owner@example.com")
    created = await _new_map(client)
    pano = (
        await client.post(
            f"/api/maps/{created['id']}/panoramas",
            json={"levelId": "l1", "position": [37.6, 55.7], "frameCount": 8},
        )
    ).json()
    meta = json.dumps({"quaternion": [1, 0, 0, 0], "width": 64, "height": 48})

    async def upload(index: int) -> int:
        response = await client.put(
            f"/api/panoramas/{pano['id']}/frames/{index}",
            files={"file": ("f.jpg", io.BytesIO(_jpeg()), "image/jpeg")},
            data={"meta": meta},
        )
        return response.status_code

    assert await asyncio.gather(*(upload(i) for i in range(8))) == [200] * 8
    assert (await client.get(f"/api/panoramas/{pano['id']}")).json()["progress"] == 100


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


async def test_draft_preview_for_team_only(client: AsyncClient, register: Register) -> None:
    """The studio preview reads the draft before any publishing; strangers get 404."""
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Черновик"})).json()
    url = f"/api/public/maps/{created['slug']}/draft.json"
    draft = await client.get(url)
    assert draft.status_code == 200, draft.text
    assert draft.headers["cache-control"] == "private, no-store"
    assert draft.json()["venue"]["name"]

    await client.post("/api/auth/logout")
    assert (await client.get(url)).status_code == 404
    await register("stranger@example.com")
    assert (await client.get(url)).status_code == 404


async def test_password_map(client: AsyncClient, register: Register) -> None:
    """A password map: strangers get 401, the right password opens it, a new one locks again."""
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "По паролю"})).json()
    map_url = f"/api/maps/{created['id']}"
    no_password = await client.patch(map_url, json={"accessMode": "password"})
    assert no_password.status_code == 422
    set_it = await client.patch(map_url, json={"accessMode": "password", "accessPassword": "сова1"})
    assert set_it.status_code == 200 and set_it.json()["hasPassword"] is True
    await client.post(f"{map_url}/publish")

    await client.post("/api/auth/logout")
    manifest = f"/api/public/maps/{created['slug']}/manifest.json"
    assert (await client.get(manifest)).status_code == 401
    unlock = f"/api/public/maps/{created['slug']}/unlock"
    assert (await client.post(unlock, json={"password": "нет"})).status_code == 403
    assert (await client.post(unlock, json={"password": "сова1"})).status_code == 204
    opened = await client.get(manifest)
    assert opened.status_code == 200, opened.text
    bundle = await client.get(opened.json()["bundleUrl"])
    assert bundle.status_code == 200

    await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "password123"}
    )
    await client.patch(map_url, json={"accessPassword": "новый-пароль"})
    await client.post("/api/auth/logout")
    assert (await client.get(manifest)).status_code == 401


async def test_versions_rollback_and_unpublish(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Версии"})).json()
    map_url = f"/api/maps/{created['id']}"
    await client.post(f"{map_url}/publish")
    await client.post(f"{map_url}/publish")
    versions = (await client.get(f"{map_url}/versions")).json()
    assert [(v["number"], v["published"]) for v in versions] == [(2, True), (1, False)]

    back = await client.post(f"{map_url}/versions/1/publish")
    assert back.status_code == 200 and back.json()["number"] == 1
    manifest = f"/api/public/maps/{created['slug']}/manifest.json"
    assert (await client.get(manifest)).json()["version"] == 1

    assert (await client.post(f"{map_url}/unpublish")).status_code == 204
    assert (await client.get(manifest)).status_code == 404
    assert (await client.get(map_url)).json()["publishedNumber"] is None
