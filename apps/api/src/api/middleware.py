"""ASGI middleware: same-origin check for browser writes and body size limits per route.

Pure ASGI (not BaseHTTPMiddleware): bodies of video uploads stream through untouched.
"""

import re
from urllib.parse import urlsplit

from fastapi import HTTPException, status
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api.config import get_settings

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
MB = 1024 * 1024

DRAFT_PATH = re.compile(r"^/api/maps/[^/]+/draft$")
VIDEO_PATH = re.compile(r"^/api/maps/[^/]+/(?:panoramas/video|scans)$")
# Multipart framing, form fields and the orientation track on top of the video itself.
VIDEO_FORM_OVERHEAD_MB = 5


def _netloc(url: str) -> str:
    return urlsplit(url).netloc.lower()


def trusted_origin(headers: Headers, origin: str) -> bool:
    """Our own origin (the Host the browser used, kept or forwarded by the dev proxy / Caddy, so a
    phone on the LAN is recognised too) or one of settings.cors_origins."""
    allowed = {o.rstrip("/").lower() for o in get_settings().cors_origins}
    if origin.rstrip("/").lower() in allowed:
        return True
    netloc = _netloc(origin)
    # X-Forwarded-Host cannot come from a forged page: browsers refuse to set it cross-origin
    # without a CORS preflight, which only cors_origins pass.
    forwarded = headers.get("x-forwarded-host", "").split(",")[0].strip().lower()
    hosts = {headers.get("host", "").lower(), forwarded} - {""}
    return bool(netloc) and netloc in hosts


class OriginCheck:
    """Browser writes must come from our own origin — signed in or not (login CSRF).

    Browsers attach Origin to every POST/PUT/PATCH/DELETE, so a request forged by another site
    always carries a foreign origin (or "null"). Clients without the header (curl, scripts,
    server-to-server) are not a browser acting on someone's behalf and pass. SameSite=Lax on the
    session cookie is the second layer.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            if origin is not None and not trusted_origin(headers, origin):
                response = JSONResponse(
                    {"detail": "Недопустимый источник запроса"},
                    status_code=status.HTTP_403_FORBIDDEN,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def body_limit(method: str, path: str) -> tuple[int, str] | None:
    """(max bytes, message) for routes with their own limit; read per request (tests patch it)."""
    settings = get_settings()
    if method == "PUT" and DRAFT_PATH.match(path):
        return (
            settings.max_draft_mb * MB,
            f"Черновик больше {settings.max_draft_mb} МБ — уберите лишнее"
            " (длинные описания, лишние подложки)",
        )
    if method == "POST" and VIDEO_PATH.match(path):
        return (
            (settings.max_video_mb + VIDEO_FORM_OVERHEAD_MB) * MB,
            f"Видео больше {settings.max_video_mb} МБ — снимите покороче",
        )
    return None


class BodyLimit:
    """Refuses oversized bodies before they are parsed: by Content-Length up front, and by
    counting while streaming (chunked uploads have no length). Caddy has its own outer limit."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        rule = body_limit(scope["method"], scope["path"]) if scope["type"] == "http" else None
        if rule is None:
            await self.app(scope, receive, send)
            return
        max_bytes, message = rule
        length = Headers(scope=scope).get("content-length", "")
        if length.isdigit() and int(length) > max_bytes:
            response = JSONResponse(
                {"detail": message}, status_code=status.HTTP_413_CONTENT_TOO_LARGE
            )
            await response(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message_ = await receive()
            if message_["type"] == "http.request":
                received += len(message_.get("body", b""))
                if received > max_bytes:
                    # FastAPI re-raises HTTPException from body reading, so this becomes a 413.
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, message)
            return message_

        await self.app(scope, limited_receive, send)
