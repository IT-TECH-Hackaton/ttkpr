"""Generates the demo venue and a synthetic grid panorama.

    uv run --package worker python -m worker.demo

Writes fixtures/demo-map.json and apps/viewer/public/demo/ (manifest, bundle, pano tiles).
The grid panorama labels yaw/pitch, so plan <-> pano projections can be checked by eye.
"""

import json
import tempfile
from pathlib import Path

import cv2
import numpy as np

from map_schema.geo import from_local
from map_schema.models import (
    Connector,
    ConnectorKind,
    ConnectorPoint,
    Level,
    LineStringGeometry,
    MapDocument,
    Opening,
    OpeningCategory,
    Pano,
    PanoStatus,
    PanoTiles,
    Poi,
    PolygonGeometry,
    Unit,
    UnitCategory,
    Venue,
)
from worker.tiles import make_tiles

ROOT = Path(__file__).resolve().parents[4]
ANCHOR = (37.6200, 55.7540)
PANO_URL = "/demo/pano-grid"


def _ll(x: float, y: float) -> tuple[float, float]:
    lon, lat = from_local(ANCHOR, (x, y))
    return round(lon, 8), round(lat, 8)


def _rect(x0: float, y0: float, x1: float, y1: float) -> PolygonGeometry:
    ring = [_ll(x0, y0), _ll(x1, y0), _ll(x1, y1), _ll(x0, y1), _ll(x0, y0)]
    return PolygonGeometry(coordinates=[ring])


def _door(x0: float, y0: float, x1: float, y1: float) -> LineStringGeometry:
    return LineStringGeometry(coordinates=[_ll(x0, y0), _ll(x1, y1)])


def build_document(tiles: PanoTiles) -> MapDocument:
    units = [
        Unit(
            id="u-corridor-1",
            level_id="l1",
            name="Коридор",
            category=UnitCategory.CORRIDOR,
            geometry=_rect(0, 8, 40, 12),
        ),
        Unit(
            id="u-hall-a",
            level_id="l1",
            name="Зал A",
            category=UnitCategory.HALL,
            geometry=_rect(0, 0, 15, 8),
        ),
        Unit(
            id="u-cloak",
            level_id="l1",
            name="Гардероб",
            category=UnitCategory.ROOM,
            geometry=_rect(15, 0, 22, 8),
        ),
        Unit(
            id="u-wc-1",
            level_id="l1",
            name="Туалет",
            category=UnitCategory.RESTROOM,
            geometry=_rect(22, 0, 28, 8),
        ),
        Unit(
            id="u-stairs-1",
            level_id="l1",
            name="Лестница",
            category=UnitCategory.STAIRS,
            geometry=_rect(28, 0, 32, 8),
        ),
        Unit(
            id="u-lobby",
            level_id="l1",
            name="Вход и регистрация",
            category=UnitCategory.LOBBY,
            geometry=_rect(32, 0, 40, 8),
        ),
        Unit(
            id="u-hall-b",
            level_id="l1",
            name="Зал B",
            category=UnitCategory.HALL,
            geometry=_rect(0, 12, 20, 24),
        ),
        Unit(
            id="u-cafe",
            level_id="l1",
            name="Кафе",
            category=UnitCategory.ROOM,
            geometry=_rect(20, 12, 32, 24),
        ),
        Unit(
            id="u-lift-1",
            level_id="l1",
            name="Лифт",
            category=UnitCategory.ELEVATOR,
            geometry=_rect(32, 12, 36, 16),
        ),
        Unit(
            id="u-corridor-2",
            level_id="l2",
            name="Коридор",
            category=UnitCategory.CORRIDOR,
            geometry=_rect(0, 8, 40, 12),
        ),
        Unit(
            id="u-conf",
            level_id="l2",
            name="Переговорная",
            category=UnitCategory.ROOM,
            geometry=_rect(0, 0, 14, 8),
        ),
        Unit(
            id="u-lab",
            level_id="l2",
            name="Лаборатория",
            category=UnitCategory.ROOM,
            geometry=_rect(0, 12, 24, 24),
        ),
        Unit(
            id="u-stairs-2",
            level_id="l2",
            name="Лестница",
            category=UnitCategory.STAIRS,
            geometry=_rect(28, 0, 32, 8),
        ),
        Unit(
            id="u-lift-2",
            level_id="l2",
            name="Лифт",
            category=UnitCategory.ELEVATOR,
            geometry=_rect(32, 12, 36, 16),
        ),
    ]
    openings = [
        Opening(id="o-hall-a", level_id="l1", geometry=_door(6, 8, 8, 8)),
        Opening(id="o-cloak", level_id="l1", geometry=_door(18, 8, 19.5, 8)),
        Opening(id="o-wc-1", level_id="l1", geometry=_door(24.5, 8, 25.5, 8)),
        Opening(id="o-stairs-1", level_id="l1", geometry=_door(29, 8, 31, 8)),
        Opening(
            id="o-lobby",
            level_id="l1",
            category=OpeningCategory.PASSAGE,
            geometry=_door(33, 8, 39, 8),
        ),
        Opening(
            id="o-entrance",
            level_id="l1",
            category=OpeningCategory.ENTRANCE,
            geometry=_door(34, 0, 38, 0),
        ),
        Opening(id="o-hall-b", level_id="l1", geometry=_door(9, 12, 11, 12)),
        Opening(id="o-cafe", level_id="l1", geometry=_door(25, 12, 27, 12)),
        Opening(id="o-lift-1", level_id="l1", geometry=_door(33, 12, 35, 12)),
        Opening(id="o-conf", level_id="l2", geometry=_door(6, 8, 8, 8)),
        Opening(id="o-lab", level_id="l2", geometry=_door(11, 12, 13, 12)),
        Opening(id="o-stairs-2", level_id="l2", geometry=_door(29, 8, 31, 8)),
        Opening(id="o-lift-2", level_id="l2", geometry=_door(33, 12, 35, 12)),
    ]
    pois = [
        Poi(
            id="p-stand-a1",
            level_id="l1",
            name="Стенд A1",
            category="stand",
            description="Партнёр хакатона: демо железа и раздача стикеров.",
            position=_ll(4, 4),
        ),
        Poi(
            id="p-stage",
            level_id="l1",
            name="Сцена",
            category="stage",
            description="Открытие в 10:00, питчи финалистов в 18:00.",
            position=_ll(10, 22),
        ),
        Poi(
            id="p-coffee",
            level_id="l1",
            name="Кофе-поинт",
            category="food",
            description="Кофе и снеки весь день.",
            position=_ll(26, 18),
        ),
        Poi(
            id="p-registration",
            level_id="l1",
            name="Регистрация",
            category="service",
            description="Бейджи и браслеты участников.",
            position=_ll(36, 4),
        ),
        Poi(
            id="p-wifi",
            level_id="l1",
            name="Wi-Fi",
            category="wifi",
            description="Сеть Hackathon, пароль на бейдже.",
            position=_ll(20, 10),
            height_m=2.5,
        ),
        Poi(
            id="p-cloak", level_id="l1", name="Гардероб", category="service", position=_ll(18.5, 4)
        ),
        Poi(
            id="p-mentors",
            level_id="l2",
            name="Менторы",
            category="service",
            description="Консультации по треку с 12:00.",
            position=_ll(7, 4),
        ),
        Poi(
            id="p-lab",
            level_id="l2",
            name="Хардверная зона",
            category="stand",
            position=_ll(12, 18),
        ),
    ]
    panos = [
        Pano(
            id="pano-corridor-west",
            level_id="l1",
            position=_ll(10, 10),
            heading_deg=0,
            status=PanoStatus.READY,
            tiles=tiles,
        ),
        Pano(
            id="pano-corridor-east",
            level_id="l1",
            position=_ll(30, 10),
            heading_deg=90,
            status=PanoStatus.READY,
            tiles=tiles,
        ),
    ]
    connectors = [
        Connector(
            id="c-stairs",
            kind=ConnectorKind.STAIRS,
            name="Лестница",
            points=[
                ConnectorPoint(level_id="l1", position=_ll(30, 4)),
                ConnectorPoint(level_id="l2", position=_ll(30, 4)),
            ],
        ),
        Connector(
            id="c-lift",
            kind=ConnectorKind.ELEVATOR,
            name="Лифт",
            points=[
                ConnectorPoint(level_id="l1", position=_ll(34, 14)),
                ConnectorPoint(level_id="l2", position=_ll(34, 14)),
            ],
        ),
    ]
    return MapDocument(
        venue=Venue(id="demo", name="Демо-площадка хакатона", anchor=ANCHOR),
        levels=[Level(id="l1", name="1 этаж", ordinal=0), Level(id="l2", name="2 этаж", ordinal=1)],
        units=units,
        openings=openings,
        connectors=connectors,
        pois=pois,
        panos=panos,
    )


def grid_panorama(width: int = 4096) -> np.ndarray:
    """Equirect with yaw/pitch grid; yaw 0 is the image center."""
    height = width // 2
    img = np.zeros((height, width, 3), np.uint8)
    img[: height // 2] = (120, 90, 60)  # ceiling, BGR
    img[height // 2 :] = (70, 80, 90)  # floor
    px_per_deg = width / 360
    for yaw in range(-180, 181, 15):
        x = int((yaw + 180) * px_per_deg)
        thick = 6 if yaw % 90 == 0 else 2
        cv2.line(img, (x, 0), (x, height), (230, 230, 230), thick)
        if yaw % 45 == 0:
            for pitch in (30, 0, -30):
                y = int((90 - pitch) * px_per_deg) - 12
                label = f"yaw {yaw:+d}" if pitch == 0 else f"{yaw:+d}/{pitch:+d}"
                cv2.putText(
                    img, label, (x + 10, y), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3
                )
    for pitch in range(-75, 90, 15):
        y = int((90 - pitch) * px_per_deg)
        thick = 6 if pitch == 0 else 2
        cv2.line(img, (0, y), (width, y), (200, 200, 200), thick)
    cv2.putText(
        img,
        "FRONT = heading",
        (width // 2 - 260, height // 2 - 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        2.2,
        (80, 220, 255),
        5,
    )
    return img


def main() -> None:
    viewer_demo = ROOT / "apps" / "viewer" / "public" / "demo"
    pano_dir = viewer_demo / "pano-grid"
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "grid.png"
        cv2.imwrite(str(source), grid_panorama())
        levels = make_tiles(source, pano_dir, level_widths=(1024, 2048, 4096))

    tiles = PanoTiles(base_url=PANO_URL, preview_url=f"{PANO_URL}/preview.webp", levels=levels)
    document = build_document(tiles)
    payload = json.loads(document.model_dump_json(by_alias=True))

    (ROOT / "fixtures" / "demo-map.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    version_dir = viewer_demo / "v1"
    version_dir.mkdir(parents=True, exist_ok=True)
    (version_dir / "bundle.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    manifest = {"slug": "demo", "title": document.venue.name, "bundleUrl": "/demo/v1/bundle.json"}
    (viewer_demo / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"demo written: {viewer_demo}")


if __name__ == "__main__":
    main()
