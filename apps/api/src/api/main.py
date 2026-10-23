from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from api.config import get_settings
from api.routers import auth, health, maps, media, members, panoramas, public

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _operation_id(route: APIRoute) -> str:
    """Short operation ids -> readable generated client (listMaps, saveDraft, ...)."""
    return route.name


def _same_origin(request: Request, origin: str) -> bool:
    # Behind the dev proxy / Caddy the browser talks to one origin; the Host it used is kept
    # (or forwarded), so a same-origin write from a phone on the LAN is recognised too.
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return bool(host) and urlsplit(origin).netloc == host


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Карта пространства API",
        version="0.2.0",
        generate_unique_id_function=_operation_id,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def csrf_origin_check(request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Cookie-authenticated writes must come from our own origin (plus SameSite=Lax)."""
        if request.method in UNSAFE_METHODS and settings.session_cookie in request.cookies:
            origin = request.headers.get("origin") or ""
            if origin not in settings.cors_origins and not _same_origin(request, origin):
                return JSONResponse({"detail": "Недопустимый источник запроса"}, status_code=403)
        return await call_next(request)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(maps.router)
    app.include_router(members.router)
    app.include_router(panoramas.router)
    app.include_router(public.router)
    app.include_router(media.router)
    return app


app = create_app()
