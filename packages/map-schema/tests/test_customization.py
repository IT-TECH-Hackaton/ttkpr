"""Room and visit customisation: optional, validated, compact, and harmless to old documents."""

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from map_schema import SCHEMA_VERSION, MapDocument
from map_schema.models import (
    Announcement,
    Fixture,
    Opening,
    Poi,
    PoiEvent,
    Unit,
    Venue,
    Zone,
)

DEMO = Path(__file__).parents[3] / "fixtures" / "demo-map.json"

ANCHOR = [37.62, 55.754]
# ~1 m in degrees at the anchor.
DX = 1 / 62_600
DY = 1 / 111_320


def ring(x0: float, y0: float, x1: float, y1: float, close: bool = True) -> list[list[float]]:
    lon0, lat0 = ANCHOR
    pts = [
        [lon0 + x0 * DX, lat0 + y0 * DY],
        [lon0 + x1 * DX, lat0 + y0 * DY],
        [lon0 + x1 * DX, lat0 + y1 * DY],
        [lon0 + x0 * DX, lat0 + y1 * DY],
    ]
    return [*pts, pts[0]] if close else pts


def poi(**extra: Any) -> dict[str, Any]:
    return {
        "id": "p",
        "levelId": "l1",
        "name": "Сцена",
        "category": "stage",
        "position": ANCHOR,
        **extra,
    }


def errors(model: Any, data: dict[str, Any]) -> list[tuple[str, str]]:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(data)
    return [(e["type"], str(e["msg"])) for e in caught.value.errors()]


def dumped(model: Any) -> dict[str, Any]:
    result: dict[str, Any] = json.loads(model.model_dump_json(by_alias=True))
    return result


# --- compatibility -------------------------------------------------------------------------------


def test_old_documents_stay_valid_and_dump_unchanged() -> None:
    original = json.loads(DEMO.read_text(encoding="utf-8"))
    original["schemaVersion"] = 1
    doc = MapDocument.model_validate(original)
    again = dumped(doc)
    # Validating upgrades the version; nothing else changes, no new keys appear.
    assert again.pop("schemaVersion") == SCHEMA_VERSION == 2
    original.pop("schemaVersion")
    assert again == original


def test_minimal_v1_document() -> None:
    doc = MapDocument.model_validate(
        {"schemaVersion": 1, "venue": {"id": "v", "name": "Отель", "anchor": ANCHOR}}
    )
    assert doc.venue.timezone == "Europe/Moscow"
    assert dumped(doc)["venue"] == {"id": "v", "name": "Отель", "anchor": ANCHOR, "address": None}


def test_one_openapi_type_for_reading_and_writing() -> None:
    # Different validation and serialization schemas would make FastAPI split MapDocument into
    # MapDocument-Input / -Output and rename the generated TS types.
    assert MapDocument.model_json_schema(mode="validation") == MapDocument.model_json_schema(
        mode="serialization"
    )


def test_schema_publishes_patterns_for_generated_validators() -> None:
    defs = MapDocument.model_json_schema()["$defs"]
    assert defs["Branding"]["properties"]["accentColor"]["anyOf"][0]["pattern"] == (
        "^#[0-9A-Fa-f]{6}$"
    )
    start = defs["PoiEvent"]["properties"]["start"]
    assert start["type"] == "string"
    assert "format" not in start  # zod's default date-time would refuse offsets
    assert "+03:00" in start["description"]
    # Translation keys are checked in Python: a key pattern would type the values as unknown.
    assert defs["Poi"]["properties"]["translations"]["additionalProperties"] == {
        "$ref": "#/$defs/Translation"
    }


# --- compact output --------------------------------------------------------------------------


def test_defaults_are_left_out() -> None:
    unit = Unit.model_validate(
        {
            "id": "u",
            "levelId": "l1",
            "category": "room",
            "geometry": {"coordinates": [ring(0, 0, 5, 5)]},
        }
    )
    assert set(dumped(unit)) == {"id", "levelId", "name", "category", "walkable", "geometry"}
    assert set(dumped(Poi.model_validate(poi()))) == {
        "id",
        "levelId",
        "name",
        "category",
        "description",
        "position",
        "heightM",
    }
    door = Opening.model_validate(
        {
            "id": "d",
            "levelId": "l1",
            "geometry": {"coordinates": [ANCHOR, [ANCHOR[0] + DX, ANCHOR[1]]]},
        }
    )
    assert set(dumped(door)) == {"id", "levelId", "category", "geometry"}


def test_set_values_are_kept() -> None:
    unit = Unit.model_validate(
        {
            "id": "u",
            "levelId": "l1",
            "category": "hall",
            "geometry": {"coordinates": [ring(0, 0, 5, 5)]},
            "access": "staff",
            "heightM": 6,
            "color": "#AABBCC",
            "description": "  Большой зал\r\nс балконом  ",
            "photos": ["https://cdn.example.ru/a.webp", "/media/maps/1/b.webp"],
            "capacity": 300,
            "amenities": ["wifi", "power", "wifi"],
            "hours": "9:00–18:00",
            "translations": {"EN": {"name": "Main hall"}, "zh": {"name": " "}},
        }
    )
    out = dumped(unit)
    assert out["access"] == "staff"
    assert out["color"] == "#aabbcc"
    assert out["description"] == "Большой зал\nс балконом"
    assert out["amenities"] == ["wifi", "power"]
    assert out["translations"] == {"en": {"name": "Main hall"}}


# --- URLs, colours, texts ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://example.ru/a.jpg",  # images load in an HTTPS page
        "https://bank.ru@evil.example/a.jpg",
        "/media/../api/maps",
        "/media/maps/./a.webp",
        "/api/maps",
        "data:image/png;base64,AAAA",
        "https://exa mple.ru/a.jpg",
    ],
)
def test_bad_image_urls(url: str) -> None:
    assert errors(Poi, poi(photos=[url]))[0][0] == "map_url"


def test_links_may_be_plain_http() -> None:
    p = Poi.model_validate(
        poi(links=[{"title": "Сайт", "url": "http://example.ru/?a=1#b"}], contacts={"website": " "})
    )
    assert p.links[0].url == "http://example.ru/?a=1#b"
    assert p.contacts is None  # all-empty contacts are dropped


def test_contacts() -> None:
    p = Poi.model_validate(
        poi(contacts={"telegram": "https://t.me/ttk_hack", "phone": "+7 (495) 123-45-67"})
    )
    assert p.contacts is not None
    assert p.contacts.telegram == "ttk_hack"
    assert (
        Poi.model_validate(poi(contacts={"telegram": "@ttk_hack"})).contacts.telegram == "ttk_hack"
    )  # type: ignore[union-attr]
    assert errors(Poi, poi(contacts={"email": "не-почта"}))[0][0] == "map_email"
    assert errors(Poi, poi(contacts={"phone": "звоните"}))[0][0] == "map_phone"


def test_colours_and_texts() -> None:
    assert errors(Poi, {**poi(), "translations": {"en": {"name": "a‮b"}}})[0][0] == "map_text"
    assert (
        errors(
            Zone,
            {
                "id": "z",
                "levelId": "l1",
                "name": "x",
                "color": "red",
                "geometry": {"coordinates": [ring(0, 0, 2, 2)]},
            },
        )[0][0]
        == "map_color"
    )
    long = "я" * 2001
    assert (
        errors(
            Unit,
            {
                "id": "u",
                "levelId": "l1",
                "category": "room",
                "description": long,
                "geometry": {"coordinates": [ring(0, 0, 5, 5)]},
            },
        )[0][0]
        == "string_too_long"
    )
    # Blank optional texts mean "not set"; names of zones are required.
    assert Poi.model_validate(poi(hours="  ")).hours is None
    assert (
        errors(
            Zone,
            {
                "id": "z",
                "levelId": "l1",
                "name": " ",
                "geometry": {"coordinates": [ring(0, 0, 2, 2)]},
            },
        )[0][0]
        == "string_too_short"
    )


def test_messages_are_for_the_editor() -> None:
    ((kind, message),) = errors(Poi, poi(photos=["ftp://x"]))
    assert kind == "map_url"
    assert message.startswith("Картинка")


def test_tags_and_limits() -> None:
    assert Poi.model_validate(poi(tags=["Питчи", "питчи ", "AI"])).tags == ["Питчи", "AI"]
    assert errors(Poi, poi(photos=["/media/a.webp"] * 11))[0][0] == "too_long"
    assert errors(Poi, poi(tags=["x" * 41]))[0][0] == "string_too_long"
    translations = {f"l{c}": {"name": "x"} for c in "abcdef"}
    assert errors(Poi, poi(translations=translations))[0][0] == "too_long"
    assert errors(Poi, poi(translations={"english": {"name": "x"}}))[0][0] == "map_lang"


# --- times ---------------------------------------------------------------------------------------


def event(**extra: Any) -> dict[str, Any]:
    return {
        "id": "e1",
        "title": "Открытие",
        "start": "2026-10-24T12:00:00+03:00",
        "end": "2026-10-24T12:45:00+03:00",
        **extra,
    }


def test_events_keep_their_offset() -> None:
    p = Poi.model_validate(
        poi(
            events=[
                event(),
                event(id="e2", start="2026-10-24T10:00:00Z", end="2026-10-24T11:00:00Z"),
            ]
        )
    )
    out = dumped(p)["events"]
    assert out[0]["start"] == "2026-10-24T12:00:00+03:00"
    assert out[1]["end"] == "2026-10-24T11:00:00Z"
    assert p.events[0].end - p.events[0].start == timedelta(minutes=45)


@pytest.mark.parametrize(
    ("change", "kind"),
    [
        ({"start": "2026-10-24T12:00:00"}, "timezone_aware"),
        ({"end": "2026-10-24T11:00:00+03:00"}, "map_time"),
        ({"end": "2026-12-24T11:00:00+03:00"}, "map_time"),
        ({"id": "два слова"}, "map_id"),
    ],
)
def test_bad_events(change: dict[str, Any], kind: str) -> None:
    assert errors(PoiEvent, event(**change))[0][0] == kind


def test_event_ids_are_unique_per_place() -> None:
    assert errors(Poi, poi(events=[event(), event()]))[0][0] == "map_duplicate"
    assert errors(Poi, poi(events=[event(id=f"e{i}") for i in range(51)]))[0][0] == "too_long"


def test_announcements() -> None:
    a = Announcement.model_validate({"id": "a", "text": "Обед с 13:00", "kind": "info"})
    assert dumped(a) == {"id": "a", "text": "Обед с 13:00"}
    bad = {
        "id": "a",
        "text": "x",
        "start": "2026-10-24T13:00:00+03:00",
        "end": "2026-10-24T12:00:00+03:00",
    }
    assert errors(Announcement, bad)[0][0] == "map_time"


# --- venue ---------------------------------------------------------------------------------------


def venue(**extra: Any) -> dict[str, Any]:
    return {"id": "v", "name": "Форум", "anchor": ANCHOR, **extra}


def test_venue_settings() -> None:
    v = Venue.model_validate(
        venue(
            timezone="Asia/Novosibirsk",
            languages=["ru", "EN", "en", "zh-Hans"],
            branding={
                "accentColor": "#2563EB",
                "logoUrl": "/media/maps/1/logo.webp",
                "welcomeTitle": "",
            },
            categories=[{"id": "partner", "label": "Партнёр", "emoji": "🤝"}],
        )
    )
    out = dumped(v)
    assert out["timezone"] == "Asia/Novosibirsk"
    assert out["languages"] == ["ru", "en", "zh-hans"]
    assert out["branding"] == {"accentColor": "#2563eb", "logoUrl": "/media/maps/1/logo.webp"}
    assert "timezone" not in dumped(Venue.model_validate(venue(timezone="Europe/Moscow")))
    assert Venue.model_validate(venue(branding={"welcomeTitle": " "})).branding is None


def test_bad_venue_settings() -> None:
    assert errors(Venue, venue(timezone="Mars/Olympus"))[0][0] == "map_timezone"
    assert errors(Venue, venue(timezone="Europe/Moscow; drop"))[0][0] == "map_timezone"
    two = [{"id": "partner", "label": "А"}, {"id": "partner", "label": "Б"}]
    assert errors(Venue, venue(categories=two))[0][0] == "map_duplicate"
    assert (
        errors(Venue, venue(categories=[{"id": "Партнёр", "label": "x"}]))[0][0] == "map_category"
    )
    assert (
        errors(Venue, venue(announcements=[{"id": f"a{i}", "text": "x"} for i in range(21)]))[0][0]
        == "too_long"
    )


# --- openings, fixtures, zones ---------------------------------------------------------------


def opening(**extra: Any) -> dict[str, Any]:
    return {
        "id": "o",
        "levelId": "l1",
        "geometry": {"coordinates": [ANCHOR, [ANCHOR[0] + 2 * DX, ANCHOR[1]]]},
        **extra,
    }


def test_windows_and_doors_keep_only_their_own_fields() -> None:
    window = Opening.model_validate(
        opening(category="window", kind="double", widthM=1, sillHeightM=0.6, heightM=1.5)
    )
    assert (window.kind, window.width_m, window.sill_height_m, window.height_m) == (
        None,
        None,
        0.6,
        1.5,
    )
    door = Opening.model_validate(
        opening(kind="revolving", widthM=2, sillHeightM=1, access="emergency")
    )
    assert dumped(door)["kind"] == "revolving"
    assert door.sill_height_m is None
    assert dumped(door)["access"] == "emergency"
    assert errors(Opening, opening(access="vip"))[0][0] == "enum"
    assert errors(Opening, opening(widthM=0.1))[0][0] == "greater_than_equal"


def fixture(**extra: Any) -> dict[str, Any]:
    return {
        "id": "t1",
        "levelId": "l1",
        "kind": "table",
        "geometry": {"coordinates": [ring(0, 0, 2, 1)]},
        **extra,
    }


def test_fixtures() -> None:
    f = Fixture.model_validate(fixture(geometry={"coordinates": [ring(0, 0, 2, 1, close=False)]}))
    coords = f.geometry.coordinates[0]
    assert coords[0] == coords[-1] and len(coords) == 5  # closed for the editor
    assert "obstacle" not in dumped(f)
    assert dumped(Fixture.model_validate(fixture(obstacle=False)))["obstacle"] is False
    assert errors(Fixture, fixture(kind="sofa"))[0][0] == "enum"
    hole = {"coordinates": [ring(0, 0, 4, 4), ring(1, 1, 2, 2)]}
    assert errors(Fixture, fixture(geometry=hole))[0][0] == "map_geometry"
    tiny = {"coordinates": [ring(0, 0, 0.05, 0.05)]}
    assert errors(Fixture, fixture(geometry=tiny))[0][0] == "map_geometry"
    spiky = {"coordinates": [[[ANCHOR[0] + i * DX, ANCHOR[1] + (i % 2) * DY] for i in range(200)]]}
    assert errors(Fixture, fixture(geometry=spiky))[0][0] == "map_geometry"
    nowhere = {"coordinates": [[[500.0, 0.0], [501.0, 0.0], [501.0, 1.0], [500.0, 0.0]]]}
    assert errors(Fixture, fixture(geometry=nowhere))[0][0] == "map_geometry"


def test_document_lists() -> None:
    zone = {
        "id": "z",
        "levelId": "l1",
        "name": "Фудкорт",
        "geometry": {"coordinates": [ring(0, 0, 6, 6)]},
    }
    doc = MapDocument.model_validate(
        {"venue": venue(), "fixtures": [fixture(), fixture(id="t2")], "zones": [zone]}
    )
    out = dumped(doc)
    assert [f["id"] for f in out["fixtures"]] == ["t1", "t2"]
    assert out["zones"][0]["name"] == "Фудкорт"
    assert "fixtures" not in dumped(MapDocument.model_validate({"venue": venue()}))
    dup = {"venue": venue(), "fixtures": [fixture(), fixture()]}
    assert errors(MapDocument, dup)[0][0] == "map_duplicate"


def test_round_trip_of_a_customised_document() -> None:
    doc = MapDocument.model_validate(
        {
            "venue": venue(
                branding={"accentColor": "#2563eb"},
                announcements=[{"id": "a", "text": "Добро пожаловать", "kind": "success"}],
            ),
            "units": [
                {
                    "id": "u",
                    "levelId": "l1",
                    "category": "hall",
                    "amenities": ["wifi"],
                    "geometry": {"coordinates": [ring(0, 0, 20, 10)]},
                }
            ],
            "openings": [opening(category="window")],
            "pois": [poi(events=[event()], featured=True, tags=["сцена"])],
            "fixtures": [fixture()],
            "zones": [
                {
                    "id": "z",
                    "levelId": "l1",
                    "name": "Фудкорт",
                    "geometry": {"coordinates": [ring(0, 0, 6, 6)]},
                }
            ],
        }
    )
    first = dumped(doc)
    assert dumped(MapDocument.model_validate(first)) == first
