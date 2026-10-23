from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://ttk:ttk@localhost:5432/ttk"
    redis_url: str = "redis://localhost:6379/0"

    public_base_url: str = "https://localhost"
    cors_origins: list[str] = [
        "https://localhost",
        "https://localhost:5173",
        "https://localhost:5174",
    ]

    session_cookie: str = "ttk_session"
    session_ttl_days: int = 30
    cookie_secure: bool = True

    s3_endpoint: str = "http://localhost:8333"
    s3_bucket: str = "ttk"
    s3_access_key: str = "minio"
    s3_secret_key: str = "minio-secret"


@lru_cache
def get_settings() -> Settings:
    return Settings()
