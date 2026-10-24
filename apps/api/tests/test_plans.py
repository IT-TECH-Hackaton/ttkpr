"""Plan recognition jobs: the upload is checked, stored privately and queued for the worker."""

from collections.abc import Awaitable, Callable
from pathlib import Path

from httpx import AsyncClient

from api.config import get_settings

Register = Callable[[str], Awaitable[None]]

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def test_plan_import_is_queued_and_polled(
    client: AsyncClient, register: Register, enqueued: list[tuple[str, ...]]
) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "План по картинке"})).json()
    url = f"/api/maps/{created['id']}/plan-imports"

    job = await client.post(url, files={"file": ("plan.pdf", PDF, "application/pdf")})
    assert job.status_code == 201, job.text
    body = job.json()
    assert body["status"] == "processing" and body["result"] is None
    assert enqueued == [("worker.tasks.recognize_plan", body["id"])]
    stored = Path(get_settings().storage_dir) / "plans" / body["id"] / "source.pdf"
    assert stored.read_bytes() == PDF

    polled = await client.get(f"/api/plan-imports/{body['id']}")
    assert polled.status_code == 200 and polled.json()["id"] == body["id"]

    image = await client.post(url, files={"file": ("plan.png", PNG, "image/png")})
    assert image.status_code == 201
    assert (Path(get_settings().storage_dir) / "plans" / image.json()["id"] / "source.img").exists()

    # The upload itself is never served.
    assert (await client.get(f"/media/plans/{body['id']}/source.pdf")).status_code == 404


async def test_plan_import_rejects_other_files_and_other_people(
    client: AsyncClient, register: Register
) -> None:
    await register("stranger@example.com")
    await client.post("/api/auth/logout")
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Чужим нельзя"})).json()
    url = f"/api/maps/{created['id']}/plan-imports"

    text = await client.post(url, files={"file": ("plan.txt", b"hello", "text/plain")})
    assert text.status_code == 415
    job = (await client.post(url, files={"file": ("plan.pdf", PDF, "application/pdf")})).json()

    await client.post("/api/auth/logout")
    await client.post(
        "/api/auth/login", json={"email": "stranger@example.com", "password": "password123"}
    )
    assert (
        await client.post(url, files={"file": ("p.pdf", PDF, "application/pdf")})
    ).status_code == 404
    assert (await client.get(f"/api/plan-imports/{job['id']}")).status_code == 404
