from httpx import ASGITransport, AsyncClient

from api.main import app


async def test_health() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://testserver") as http:
        response = await http.get("/api/health")
    assert response.json() == {"status": "ok"}


def test_openapi_exposes_map_document_in_camel_case() -> None:
    schemas = app.openapi()["components"]["schemas"]
    assert "MapDocument" in schemas
    assert "headingDeg" in schemas["Pano"]["properties"]
