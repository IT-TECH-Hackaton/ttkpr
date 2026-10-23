from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/api/src/api/config.py -> repository root
REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://ttk:ttk@localhost:5432/ttk"
    redis_url: str = "redis://localhost:6379/0"

    # Extra origins allowed to call the API with cookies. The viewer and the studio share one
    # origin (dev proxy, Caddy), and same-origin requests are always allowed — also from a phone
    # on the LAN — so this is empty unless another site embeds the studio's API.
    cors_origins: list[str] = []

    # "production" refuses placeholder secrets at startup.
    app_env: str = "dev"
    # Signs capture tokens (QR "снять с телефона") and invites. Must be set in production.
    secret_key: str = "dev-secret-change-me"
    session_cookie: str = "ttk_session"
    session_ttl_days: int = 30
    cookie_secure: bool = True
    capture_token_ttl_minutes: int = 120

    # Uploaded frames, panoramas and underlays; served under media_url. Shared with the worker.
    storage_dir: Path = REPO_ROOT / "data" / "storage"
    media_url: str = "/media"
    max_upload_mb: int = 25


@lru_cache
def get_settings() -> Settings:
    return Settings()
