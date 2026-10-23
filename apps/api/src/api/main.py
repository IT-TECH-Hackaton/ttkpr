from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from api.config import get_settings
from api.routers import auth, health, maps

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _operation_id(route: APIRoute) -> str:
    """Short operation ids -> readable generated client (listMaps, saveDraft, ...)."""
    return route.name


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Карта пространства API",
        version="0.1.0",
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
        """Cookie-authenticated writes must come from our own origins (plus SameSite=Lax)."""
        if request.method in UNSAFE_METHODS and settings.session_cookie in request.cookies:
            origin = request.headers.get("origin")
            if origin not in settings.cors_origins:
                return JSONResponse({"detail": "Недопустимый источник запроса"}, status_code=403)
        return await call_next(request)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(maps.router)
    return app


app = create_app()
