from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/api/src/api/config.py -> repository root
REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://ttk:ttk@localhost:5432/ttk"
    redis_url: str = "redis://localhost:6379/0"

    public_base_url: str = "https://localhost"
    # Cross-origin callers allowed with cookies. Same-origin requests (through the dev proxy
    # or Caddy) are always allowed, including from a phone on the LAN.
    cors_origins: list[str] = [
        "https://localhost",
        "https://localhost:5173",
        "https://localhost:5174",
    ]

    # Signs capture tokens (QR "снять с телефона"). Must be set in production.
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
