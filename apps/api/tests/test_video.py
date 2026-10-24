"""Video intake: panoramas from a turn-around video and room scans from a walk-around video."""

import json
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.config import get_settings
from api.models import RoomScan

Register = Callable[[str], Awaitable[None]]

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 4096
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096
MOV = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 4096
HEIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 4096
ORIENTATION = {
    "samples": [{"t": 0.5, "q": [0.7071, 0, 0.7071, 0]}, {"t": 0.0, "q": [1, 0, 0, 0]}],
    "fovDeg": 65,
    "device": "dropped: not part of the contract",
}
PLACE = {"levelId": "l1", "lon": "37.6", "lat": "55.7"}


def _files(video: bytes = WEBM, orientation: Any = ORIENTATION) -> dict[str, Any]:
    files: dict[str, Any] = {"file": ("clip.webm", video, "video/webm")}
    if orientation is not None:
        files["orientation"] = ("orientation.json", json.dumps(orientation), "application/json")
    return files


async def _switch(client: AsyncClient, email: str) -> None:
    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, r.text


async def _team_map(client: AsyncClient, register: Register) -> str:
    """Owner with a photographer and a viewer, plus a stranger; the owner is signed in."""
    for email in ("photo@example.com", "viewer@example.com", "stranger@example.com"):
        await register(email)
        await client.post("/api/auth/logout")
    await register("owner@example.com")
    map_id: str = (await client.post("/api/maps", json={"title": "Видео"})).json()["id"]
    for email, role in (("photo@example.com", "photographer"), ("viewer@example.com", "viewer")):
        r = await client.post(f"/api/maps/{map_id}/members", json={"email": email, "role": role})
        assert r.status_code == 201, r.text
    return map_id


async def test_video_panorama_from_the_phone(
    client: AsyncClient, register: Register, enqueued: list[tuple[str, ...]], tmp_path: Path
) -> None:
    map_id = await _team_map(client, register)
    token = (await client.post(f"/api/maps/{map_id}/capture-token")).json()["token"]
    await client.post("/api/auth/logout")  # the phone only has the QR token
    phone = {"X-Capture-Token": token}

    created = await client.post(
        f"/api/maps/{map_id}/panoramas/video",
        files=_files(),
        data={**PLACE, "headingDeg": "370"},
        headers=phone,
    )
    assert created.status_code == 201, created.text
    pano = created.json()
    assert (pano["source"], pano["status"], pano["headingDeg"]) == ("video", "processing", 10)
    assert pano["position"] == [37.6, 55.7] and pano["levelId"] == "l1"
    assert enqueued[-1] == ("worker.tasks.stitch_video", pano["id"])

    folder = tmp_path / "storage" / "captures" / pano["id"]
    assert (folder / "video.webm").read_bytes() == WEBM
    stored = json.loads((folder / "orientation.json").read_text())
    # Only the documented fields, samples in time order.
    assert stored == {
        "samples": [{"t": 0.0, "q": [1, 0, 0, 0]}, {"t": 0.5, "q": [0.7071, 0, 0.7071, 0]}],
        "fovDeg": 65,
    }
    assert (await client.get(f"/api/panoramas/{pano['id']}", headers=phone)).status_code == 200
    # Raw videos are never served.
    assert (await client.get(f"/media/captures/{pano['id']}/video.webm")).status_code == 404

    # Without orientation, as MP4 and MOV (iPhone).
    for video, ext in ((MP4, "mp4"), (MOV, "mov")):
        plain = await client.post(
            f"/api/maps/{map_id}/panoramas/video",
            files=_files(video, None),
            data=PLACE,
            headers=phone,
        )
        assert plain.status_code == 201, plain.text
        folder = tmp_path / "storage" / "captures" / plain.json()["id"]
        assert (folder / f"video.{ext}").is_file() and not (folder / "orientation.json").exists()


async def test_video_panorama_access(client: AsyncClient, register: Register) -> None:
    map_id = await _team_map(client, register)
    url = f"/api/maps/{map_id}/panoramas/video"
    await client.post("/api/auth/logout")
    assert (await client.post(url, files=_files(), data=PLACE)).status_code == 401
    forged = {"X-Capture-Token": f"{uuid.uuid4().hex}.{uuid.uuid4().hex}.9999999999.x"}
    assert (await client.post(url, files=_files(), data=PLACE, headers=forged)).status_code == 401
    await _switch(client, "stranger@example.com")
    assert (await client.post(url, files=_files(), data=PLACE)).status_code == 404
    await _switch(client, "viewer@example.com")
    assert (await client.post(url, files=_files(), data=PLACE)).status_code == 403
    await _switch(client, "photo@example.com")
    assert (await client.post(url, files=_files(), data=PLACE)).status_code == 201


async def test_video_panorama_rejects_bad_input(
    client: AsyncClient,
    register: Register,
    enqueued: list[tuple[str, ...]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Плохое видео"})).json()["id"]
    url = f"/api/maps/{map_id}/panoramas/video"

    async def post(**kwargs: Any) -> Any:
        kwargs.setdefault("files", _files())
        kwargs.setdefault("data", PLACE)
        return await client.post(url, **kwargs)

    assert (await post(files=_files(HEIC))).status_code == 415  # a photo, not a video
    assert (await post(files=_files(b"<svg onload=alert(1)>" * 10))).status_code == 415
    no_level = await post(data={"lon": "37.6", "lat": "55.7"})
    assert no_level.status_code == 422
    assert no_level.json()["detail"][0]["loc"] == ["body", "levelId"]
    assert (await post(data={**PLACE, "lon": "200"})).status_code == 422
    assert (await post(data={**PLACE, "headingDeg": "nan"})).status_code == 422
    assert (
        await post(files={"orientation": ("o.json", "{}", "application/json")})
    ).status_code == 422
    for track in (
        {"samples": [{"t": 0, "q": [1, 0, 0]}]},
        {"samples": [{"t": "soon", "q": [1, 0, 0, 0]}]},
        {"samples": [{"t": 0, "q": [1, 0, 0, 0]}] * 20_001},
        [1, 2, 3],
    ):
        bad = await post(files=_files(orientation=track))
        assert bad.status_code == 422, track
        assert "дорожка ориентации" in bad.json()["detail"]
    as_text = await post(files=_files(orientation=None), data={**PLACE, "orientation": "{}"})
    assert as_text.status_code == 422

    # Size: by the file itself, and by Content-Length before anything is parsed.
    monkeypatch.setattr(get_settings(), "max_video_mb", 1)
    big = await post(files=_files(WEBM + b"\x00" * (2 * 1024 * 1024), None))
    assert big.status_code == 413 and "Видео больше 1 МБ" in big.json()["detail"]
    huge = await post(files=_files(WEBM + b"\x00" * (7 * 1024 * 1024), None))
    assert huge.status_code == 413

    assert enqueued == []
    assert not (tmp_path / "storage" / "captures").exists() or not any(
        (tmp_path / "storage" / "captures").iterdir()
    )


async def test_failed_video_panorama_can_be_retried(
    client: AsyncClient,
    register: Register,
    enqueued: list[tuple[str, ...]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Очередь"})).json()["id"]

    def broker_down(*args: str) -> None:
        raise HTTPException(503, "Очередь обработки недоступна, попробуйте позже")

    monkeypatch.setattr("api.queue.enqueue", broker_down)
    down = await client.post(f"/api/maps/{map_id}/panoramas/video", files=_files(), data=PLACE)
    assert down.status_code == 503
    [pano] = (await client.get(f"/api/maps/{map_id}/panoramas")).json()
    assert pano["status"] == "failed"

    monkeypatch.setattr("api.queue.enqueue", lambda *args: enqueued.append(args))
    retried = await client.post(f"/api/panoramas/{pano['id']}/stitch")
    assert retried.status_code == 200
    assert (retried.json()["status"], retried.json()["error"]) == ("processing", None)
    assert enqueued[-1] == ("worker.tasks.stitch_video", pano["id"])


async def test_room_scan_flow(
    client: AsyncClient,
    register: Register,
    enqueued: list[tuple[str, ...]],
    tmp_path: Path,
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Сканы"})).json()["id"]
    created = await client.post(
        f"/api/maps/{map_id}/scans",
        files=_files(MP4),
        data={"levelId": "l2", "cameraHeightM": "1.3"},
    )
    assert created.status_code == 201, created.text
    scan = created.json()
    assert set(scan) == {
        "id",
        "mapId",
        "levelId",
        "status",
        "progress",
        "error",
        "cameraHeightM",
        "result",
        "createdAt",
    }
    assert (scan["mapId"], scan["levelId"], scan["cameraHeightM"]) == (map_id, "l2", 1.3)
    assert (scan["status"], scan["progress"], scan["result"]) == ("processing", 0, None)
    assert enqueued[-1] == ("worker.tasks.scan_room", scan["id"])
    folder = tmp_path / "storage" / "scans" / scan["id"]
    assert (folder / "video.mp4").read_bytes() == MP4 and (folder / "orientation.json").is_file()

    # What the worker writes comes back as is.
    result = {"polygon": [[0, 0], [4.2, 0], [4.2, 3.1], [0, 3.1]], "heightM": 2.7, "areaM2": 13.0}
    async with db_sessionmaker() as db:
        await db.execute(
            update(RoomScan)
            .where(RoomScan.id == uuid.UUID(scan["id"]))
            .values(status="ready", progress=100, result=result)
        )
        await db.commit()
    ready = (await client.get(f"/api/scans/{scan['id']}")).json()
    assert (ready["status"], ready["result"]) == ("ready", result)
    second = await client.post(f"/api/maps/{map_id}/scans", files=_files(), data={"levelId": "l1"})
    assert second.json()["cameraHeightM"] == 1.5
    listed = (await client.get(f"/api/maps/{map_id}/scans")).json()
    assert [s["id"] for s in listed] == [second.json()["id"], scan["id"]]  # newest first

    assert (await client.get(f"/media/scans/{scan['id']}/video.mp4")).status_code == 404
    assert (await client.delete(f"/api/scans/{scan['id']}")).status_code == 204
    assert not folder.exists()
    assert (await client.get(f"/api/scans/{scan['id']}")).status_code == 404

    # Deleting the map takes the remaining scans' files with it.
    other = tmp_path / "storage" / "scans" / second.json()["id"]
    assert other.is_dir()
    assert (await client.delete(f"/api/maps/{map_id}")).status_code == 204
    assert not other.exists()


async def test_room_scan_access(client: AsyncClient, register: Register) -> None:
    map_id = await _team_map(client, register)
    token = (await client.post(f"/api/maps/{map_id}/capture-token")).json()["token"]
    await client.post("/api/auth/logout")
    phone = {"X-Capture-Token": token}
    url = f"/api/maps/{map_id}/scans"
    scan = (await client.post(url, files=_files(), data={"levelId": "l1"}, headers=phone)).json()
    assert (await client.get(f"/api/scans/{scan['id']}", headers=phone)).status_code == 200
    assert len((await client.get(url, headers=phone)).json()) == 1
    # Deleting is editing: never with the QR token alone.
    assert (await client.delete(f"/api/scans/{scan['id']}", headers=phone)).status_code == 401
    assert (await client.post(url, files=_files(), data={"levelId": "l1"})).status_code == 401

    await _switch(client, "stranger@example.com")
    assert (await client.get(f"/api/scans/{scan['id']}")).status_code == 404
    assert (await client.get(url)).status_code == 404
    assert (await client.post(url, files=_files(), data={"levelId": "l1"})).status_code == 404
    assert (await client.delete(f"/api/scans/{scan['id']}")).status_code == 404
    await _switch(client, "viewer@example.com")
    assert (await client.get(f"/api/scans/{scan['id']}")).status_code == 200
    assert (await client.post(url, files=_files(), data={"levelId": "l1"})).status_code == 403
    await _switch(client, "photo@example.com")
    assert (await client.delete(f"/api/scans/{scan['id']}")).status_code == 403
    await _switch(client, "owner@example.com")
    assert (await client.delete(f"/api/scans/{scan['id']}")).status_code == 204


async def test_room_scan_rejects_bad_input(
    client: AsyncClient, register: Register, enqueued: list[tuple[str, ...]]
) -> None:
    await register("owner@example.com")
    map_id = (await client.post("/api/maps", json={"title": "Плохой скан"})).json()["id"]
    url = f"/api/maps/{map_id}/scans"
    tall = await client.post(url, files=_files(), data={"levelId": "l1", "cameraHeightM": "10"})
    assert tall.status_code == 422
    assert tall.json()["detail"][0]["loc"] == ["body", "cameraHeightM"]
    assert (await client.post(url, files=_files(), data={})).status_code == 422
    assert (await client.post(url, files=_files(HEIC), data={"levelId": "l1"})).status_code == 415
    assert (await client.get(f"/api/scans/{uuid.uuid4()}")).status_code == 404
    assert enqueued == []
