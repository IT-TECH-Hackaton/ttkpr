"""Cross-cutting protections: CSRF by Origin, body size limits, sessions, rate limits."""

import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import redis
from fastapi import HTTPException, Request
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api import ratelimit
from api.config import Settings, get_settings
from api.models import Session, User
from api.storage import Storage

Register = Callable[[str], Awaitable[None]]

EVIL = {"Origin": "https://evil.example"}


async def test_login_csrf_is_rejected_without_a_session(
    client: AsyncClient, register: Register
) -> None:
    await register("victim@example.com")
    await client.post("/api/auth/logout")
    # A page on another site logging the visitor into someone else's account.
    forged = await client.post(
        "/api/auth/login",
        json={"email": "victim@example.com", "password": "password123"},
        headers=EVIL,
    )
    assert forged.status_code == 403
    assert forged.json()["detail"] == "Недопустимый источник запроса"
    assert "set-cookie" not in forged.headers
    signup = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "name": "X", "password": "password123"},
        headers={"Origin": "null"},  # sandboxed iframes and data: pages send "null"
    )
    assert signup.status_code == 403


async def test_origin_rules(
    client: AsyncClient, register: Register, monkeypatch: pytest.MonkeyPatch
) -> None:
    await register("owner@example.com")
    # Reads are never blocked: the Origin check covers writes only.
    assert (await client.get("/api/maps", headers=EVIL)).status_code == 200
    # Behind Caddy / the dev proxy the browser's host arrives as X-Forwarded-Host.
    proxied = await client.post(
        "/api/maps",
        json={"title": "Через прокси"},
        headers={"Origin": "https://map.example.ru", "X-Forwarded-Host": "map.example.ru"},
    )
    assert proxied.status_code == 201
    # Same host, other case or a trailing slash: still our origin.
    upper = await client.post(
        "/api/maps", json={"title": "Регистр"}, headers={"Origin": "https://TESTSERVER/"}
    )
    assert upper.status_code == 201
    # Explicitly allowed partner origins.
    partner = {"Origin": "https://partner.example"}
    assert (
        await client.post("/api/maps", json={"title": "Партнёр"}, headers=partner)
    ).status_code == 403
    monkeypatch.setattr(get_settings(), "cors_origins", ["https://partner.example"])
    assert (
        await client.post("/api/maps", json={"title": "Партнёр"}, headers=partner)
    ).status_code == 201


async def test_requests_without_origin_pass(client: AsyncClient, register: Register) -> None:
    """curl and server-to-server calls send no Origin: they are not a browser to forge."""
    await register("script@example.com")
    del client.headers["Origin"]
    created = await client.post("/api/maps", json={"title": "Скрипт"})
    assert created.status_code == 201


def _peer(host: str = "10.1.2.3") -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [], "client": (host, 1)}
    )


async def test_login_attempts_are_limited_per_email(
    client: AsyncClient, register: Register
) -> None:
    await register("target@example.com")
    await client.post("/api/auth/logout")
    wrong = {"email": "target@example.com", "password": "wrong-password"}
    for _ in range(10):
        assert (await client.post("/api/auth/login", json=wrong)).status_code == 401
    right = {"email": "target@example.com", "password": "password123"}
    assert (await client.post("/api/auth/login", json=right)).status_code == 429
    # Someone else behind the same NAT is not locked out.
    await register("neighbour@example.com")


async def test_rate_limit_falls_back_to_memory_when_redis_is_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_settings(), "redis_url", "redis://127.0.0.1:1/0")
    ratelimit.reset()
    started = time.perf_counter()
    for _ in range(3):
        await ratelimit.limit(_peer(), "fallback", max_hits=3, window_s=60)
    with pytest.raises(HTTPException) as refused:
        await ratelimit.limit(_peer(), "fallback", max_hits=3, window_s=60)
    assert refused.value.status_code == 429
    await ratelimit.limit(_peer("10.9.9.9"), "fallback", max_hits=3, window_s=60)
    # One failed connection attempt, then Redis is skipped for a while: no request waits.
    assert time.perf_counter() - started < 2.5
    await ratelimit.aclose()
    ratelimit.reset()


def _redis_up() -> bool:
    try:
        with redis.Redis.from_url(get_settings().redis_url, socket_connect_timeout=0.5) as r:
            return bool(r.ping())
    except (redis.RedisError, OSError):
        return False


@pytest.mark.skipif(not _redis_up(), reason="Redis is not running")
async def test_rate_limit_is_shared_between_processes() -> None:
    ratelimit.reset()
    for _ in range(2):
        await ratelimit.limit(_peer(), "shared", max_hits=2, window_s=30, subject="a@b.c")
    # Another uvicorn worker: no local counters, a connection of its own.
    ratelimit._hits.clear()
    await ratelimit.aclose()
    with pytest.raises(HTTPException):
        await ratelimit.limit(_peer(), "shared", max_hits=2, window_s=30, subject="a@b.c")
    with redis.Redis.from_url(get_settings().redis_url) as r:
        keys = list(r.scan_iter(match=f"{ratelimit.KEY_PREFIX}shared:*"))
        assert len(keys) == 1 and b"a@b.c" not in keys[0]  # emails are hashed
        assert 0 < r.pttl(keys[0]) <= 30_000
    await ratelimit.aclose()
    ratelimit.reset()


async def test_session_cookie_is_host_prefixed(client: AsyncClient) -> None:
    signup = await client.post(
        "/api/auth/register",
        json={"email": "cookie@example.com", "name": "К", "password": "password123"},
    )
    cookie = signup.headers["set-cookie"]
    assert cookie.startswith("__Host-ttk_session=")
    attributes = {part.strip().split("=")[0].lower() for part in cookie.split(";")}
    assert {"httponly", "secure", "path", "samesite"} <= attributes
    assert "domain" not in attributes  # __Host- cookies must be host-only
    assert (await client.get("/api/auth/me")).status_code == 200
    # The delete must carry Secure too, or browsers keep the __Host- cookie.
    bye = await client.post("/api/auth/logout")
    assert "secure" in bye.headers["set-cookie"].lower()
    assert "max-age=0" in bye.headers["set-cookie"].lower()


def test_session_cookie_name_follows_secure_flag() -> None:
    assert Settings(cookie_secure=False).session_cookie == "ttk_session"
    assert Settings(cookie_secure=True).session_cookie == "__Host-ttk_session"
    assert Settings(session_cookie="custom", cookie_secure=True).session_cookie == "custom"


async def test_login_drops_expired_sessions(
    client: AsyncClient, register: Register, db_sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    await register("old@example.com")
    async with db_sessionmaker() as db:
        user = await db.scalar(select(User).where(User.email == "old@example.com"))
        assert user is not None
        past = datetime.now(UTC) - timedelta(days=1)
        db.add_all(
            [Session(user_id=user.id, token_hash=f"{i:064x}", expires_at=past) for i in range(3)]
        )
        await db.commit()
    login = await client.post(
        "/api/auth/login", json={"email": "old@example.com", "password": "password123"}
    )
    assert login.status_code == 200
    async with db_sessionmaker() as db:
        sessions = list(await db.scalars(select(Session).where(Session.user_id == user.id)))
    # The registration session and the new one remain; the three expired ones are gone.
    assert len(sessions) == 2
    assert all(s.expires_at > datetime.now(UTC) for s in sessions)


async def test_oversized_draft_is_refused(
    client: AsyncClient, register: Register, monkeypatch: pytest.MonkeyPatch
) -> None:
    await register("big@example.com")
    created = (await client.post("/api/maps", json={"title": "Большая"})).json()
    url = f"/api/maps/{created['id']}/draft"
    draft = (await client.get(url)).json()
    draft["document"]["venue"]["address"] = "x" * 6_000_000
    big = await client.put(url, json=draft)
    assert big.status_code == 413
    assert big.json()["detail"].startswith("Черновик больше 5 МБ")

    # A chunked body has no Content-Length: it is counted while it streams in.
    monkeypatch.setattr(get_settings(), "max_draft_mb", 1)
    body = json.dumps(draft).encode()

    async def chunks() -> AsyncIterator[bytes]:
        for start in range(0, len(body), 256 * 1024):
            yield body[start : start + 256 * 1024]

    streamed = await client.put(url, content=chunks(), headers={"Content-Type": "application/json"})
    assert "content-length" not in streamed.request.headers
    assert streamed.status_code == 413

    draft["document"]["venue"]["address"] = "ул. Ленина, 1"
    assert (await client.put(url, json=draft)).status_code == 200


def test_storage_keys_cannot_escape(tmp_path: Path) -> None:
    storage = Storage(tmp_path, "/media")
    for key in (
        "",
        "../x",
        "panos/../captures/x",
        "panos/./x",
        "panos//x",
        "/etc/passwd",
        r"panos\..\captures",
        "C:/Windows",
        "panos/x.",
        "panos/x ",
        "panos/\0",
    ):
        with pytest.raises(ValueError):
            storage.path(key)
    assert storage.path("panos/a/tiles/1024/0_0.webp") == tmp_path.resolve().joinpath(
        "panos", "a", "tiles", "1024", "0_0.webp"
    )


async def test_media_serves_only_published_prefixes(client: AsyncClient, tmp_path: Path) -> None:
    root = tmp_path / "storage"
    for key in (
        "captures/p/00.jpg",
        "captures/p/video.webm",
        "scans/s/video.webm",
        "panos/p/preview.webp",
        "maps/m/v/1/bundle.json",
    ):
        (root / key).parent.mkdir(parents=True, exist_ok=True)
        (root / key).write_bytes(b"x")
    assert (await client.get("/media/panos/p/preview.webp")).status_code == 200
    assert (await client.get("/media/maps/m/v/1/bundle.json")).status_code == 200
    for path in (
        "/media/captures/p/00.jpg",
        "/media/captures/p/video.webm",
        "/media/scans/s/video.webm",
        "/media/panos/..%2Fcaptures/p/00.jpg",
        "/media/panos/%2e%2e/scans/s/video.webm",
        "/media/maps/..%5C..%5Cscans%5Cs%5Cvideo.webm",
    ):
        assert (await client.get(path)).status_code == 404, path
