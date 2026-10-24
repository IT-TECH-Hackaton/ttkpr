"""Chat with the organizers: a visitor asks on a published map, the team answers."""

from collections.abc import Awaitable, Callable

from httpx import AsyncClient

Register = Callable[[str], Awaitable[None]]


async def test_visitor_asks_and_team_answers(client: AsyncClient, register: Register) -> None:
    await register("owner@example.com")
    created = (await client.post("/api/maps", json={"title": "Чат"})).json()
    public = f"/api/public/maps/{created['slug']}/chat"
    assert (await client.post(public, json={"text": "Где гардероб?"})).status_code == 404
    await client.post(f"/api/maps/{created['id']}/publish")

    await client.post("/api/auth/logout")  # a visitor
    asked = await client.post(public, json={"text": "  Где гардероб?  ", "name": "Аня"})
    assert asked.status_code == 200, asked.text
    thread = asked.json()["thread"]
    assert [m["text"] for m in asked.json()["messages"]] == ["Где гардероб?"]
    assert (await client.post(public, json={"text": " "})).status_code == 422

    await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "password123"}
    )
    inbox = (await client.get(f"/api/maps/{created['id']}/chat")).json()
    assert inbox[0]["thread"] == thread and inbox[0]["messages"][0]["name"] == "Аня"
    answer = await client.post(
        f"/api/maps/{created['id']}/chat/{thread}", json={"text": "На первом этаже"}
    )
    assert answer.status_code == 200

    await client.post("/api/auth/logout")
    seen = (await client.get(f"{public}/{thread}")).json()
    assert [(m["author"], m["text"]) for m in seen["messages"]] == [
        ("visitor", "Где гардероб?"),
        ("organizer", "На первом этаже"),
    ]
    other = await client.post(f"/api/maps/{created['id']}/chat/{thread}", json={"text": "x"})
    assert other.status_code == 401
