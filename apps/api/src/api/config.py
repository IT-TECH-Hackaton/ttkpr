from functools import lru_cache
from pathlib import Path
from typing import Self

from pydantic import model_validator
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
    # Empty: "__Host-ttk_session" with Secure cookies — browsers then accept it only with
    # Secure, Path=/ and no Domain, so a sibling subdomain cannot plant or overwrite the
    # session — and "ttk_session" without them. Set SESSION_COOKIE to override.
    session_cookie: str = ""
    session_ttl_days: int = 30
    cookie_secure: bool = True
    capture_token_ttl_minutes: int = 120

    # Uploaded frames, panoramas and underlays; served under media_url. Shared with the worker.
    storage_dir: Path = REPO_ROOT / "data" / "storage"
    media_url: str = "/media"
    max_upload_mb: int = 25
    # A plan of a big venue is ~1 MB of JSON; anything far bigger is a mistake or abuse.
    max_draft_mb: int = 5
    # Panorama and room-scan videos (streamed to disk, never held in memory).
    max_video_mb: int = 300

    @model_validator(mode="after")
    def _session_cookie_name(self) -> Self:
        if not self.session_cookie:
            self.session_cookie = "__Host-ttk_session" if self.cookie_secure else "ttk_session"
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
