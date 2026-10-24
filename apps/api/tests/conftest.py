import os
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from api import models, ratelimit  # noqa: F401
from api.config import get_settings
from api.db import Base, get_db
from api.main import app

# Same origin as the test server: the viewer, the studio and the API share one origin.
ORIGIN = "https://testserver"
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


@pytest.fixture
def enqueued() -> list[tuple[str, ...]]:
    return []


@pytest.fixture
async def db_sessionmaker() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not set")
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def client(
    db_sessionmaker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    enqueued: list[tuple[str, ...]],
) -> AsyncIterator[AsyncClient]:
    async def override_db() -> AsyncIterator[AsyncSession]:
        async with db_sessionmaker() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr("api.queue.enqueue", lambda *args: enqueued.append(args))
    monkeypatch.setattr(get_settings(), "storage_dir", tmp_path / "storage")
    ratelimit.reset()
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="https://testserver", headers={"Origin": ORIGIN}
    ) as http:
        yield http
    app.dependency_overrides.clear()
    await ratelimit.aclose()


Register = Callable[[str], Awaitable[None]]


@pytest.fixture
def register(client: AsyncClient) -> Register:
    async def _register(email: str) -> None:
        response = await client.post(
            "/api/auth/register", json={"email": email, "name": "Тест", "password": "password123"}
        )
        assert response.status_code == 201, response.text

    return _register
