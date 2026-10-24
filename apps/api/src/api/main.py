from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from api.config import get_settings
from api.middleware import BodyLimit, OriginCheck
from api.routers import (
    auth,
    chat,
    health,
    live,
    maps,
    media,
    members,
    panoramas,
    plans,
    public,
    scans,
    stats,
)


def _operation_id(route: APIRoute) -> str:
    """Short operation ids -> readable generated client (listMaps, saveDraft, ...)."""
    return route.name


PLACEHOLDER_SECRETS = {"dev-secret-change-me", "change-me", "change-me-in-production"}


def create_app() -> FastAPI:
    settings = get_settings()
    if settings.app_env == "production" and (
        settings.secret_key in PLACEHOLDER_SECRETS or len(settings.secret_key) < 32
    ):
        raise RuntimeError("SECRET_KEY: задайте случайную строку от 32 символов (infra/.env)")
    app = FastAPI(
        title="Карта пространства API",
        version="0.3.0",
        generate_unique_id_function=_operation_id,
    )

    # The last added runs first: the origin check, then body limits, then CORS.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(BodyLimit)
    app.add_middleware(OriginCheck)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(maps.router)
    app.include_router(members.router)
    app.include_router(panoramas.router)
    app.include_router(scans.router)
    app.include_router(plans.router)
    app.include_router(live.router)
    app.include_router(public.router)
    app.include_router(stats.router)
    app.include_router(chat.router)
    app.include_router(media.router)
    return app


app = create_app()
