"""Generates the demo venue with a real 360° scene in every main room.

    uv run --package worker python -m worker.demo

Writes fixtures/demo-map.json and apps/viewer/public/demo/ (manifest, bundle, pano tiles).
The scenes are CC0 interiors from Poly Haven (https://polyhaven.com/hdris/indoor), downloaded
once into data/pano-src/ (not in git) and tiled like captured panoramas. `--grid` puts the
synthetic yaw/pitch grid everywhere instead, to check plan <-> pano projections by eye.
"""

import argparse
import json
import math
import shutil
import tempfile
import urllib.request
from pathlib import Path
from typing import NamedTuple

import cv2
import numpy as np

from map_schema.geo import from_local
from map_schema.models import (
    Connector,
    ConnectorKind,
    ConnectorPoint,
    Fixture,
    FixtureKind,
    Level,
    LineStringGeometry,
    MapDocument,
    Opening,
    OpeningCategory,
    Pano,
    PanoStatus,
    PanoTileLevel,
    PanoTiles,
    PathLine,
    Poi,
    PolygonGeometry,
    Tour,
    Unit,
    UnitCategory,
    Venue,
)
from worker.tiles import make_tiles

ROOT = Path(__file__).resolve().parents[4]
ANCHOR = (37.6200, 55.7540)
SCENES_DIR = ROOT / "data" / "pano-src"
SCENE_URL = "https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/{}.jpg"


class DemoPano(NamedTuple):
    id: str
    level_id: str
    x: float
    y: float
    heading: float
    scene: str


# Where the camera stands (local metres) and which Poly Haven scene plays the room.
DEMO_PANOS = [
    DemoPano("pano-corridor-west", "l1", 10, 10, 0, "large_corridor"),
    DemoPano("pano-corridor-east", "l1", 30, 10, 90, "newman_lobby"),
    DemoPano("pano-hall-a", "l1", 10, 4.5, 0, "events_hall_interior"),
    DemoPano("pano-lobby", "l1", 35, 5, 270, "entrance_hall"),
    DemoPano("pano-hall-b", "l1", 10, 16, 0, "music_hall_02"),
    DemoPano("pano-cafe", "l1", 24, 17, 90, "comfy_cafe"),
    DemoPano("pano-tent", "l1", 35, -19, 0, "floral_tent"),
    DemoPano("pano-conf", "l2", 8.5, 5, 0, "poly_haven_studio"),
    DemoPano("pano-lab", "l2", 8, 17, 90, "university_workshop"),
]


def pano_url(pano_id: str) -> str:
    return f"/demo/{pano_id}"


def _ll(x: float, y: float) -> tuple[float, float]:
    lon, lat = from_local(ANCHOR, (x, y))
    return round(lon, 8), round(lat, 8)


def _rect(x0: float, y0: float, x1: float, y1: float) -> PolygonGeometry:
    ring = [_ll(x0, y0), _ll(x1, y0), _ll(x1, y1), _ll(x0, y1), _ll(x0, y0)]
    return PolygonGeometry(coordinates=[ring])


def _door(x0: float, y0: float, x1: float, y1: float) -> LineStringGeometry:
    return LineStringGeometry(coordinates=[_ll(x0, y0), _ll(x1, y1)])


def build_document(tiles: dict[str, PanoTiles]) -> MapDocument:
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
        # Second building across the yard: the partners' tent, reached by a walkway.
        Opening(
            id="o-tent",
            level_id="l1",
            category=OpeningCategory.ENTRANCE,
            geometry=_door(35, -14, 39, -14),
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
            id="p-tent",
            level_id="l1",
            name="Шатёр партнёров",
            category="stand",
            description="Отдельное здание во дворе: стенды партнёров и мерч.",
            position=_ll(37, -20),
        ),
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
            id=p.id,
            level_id=p.level_id,
            position=_ll(p.x, p.y),
            heading_deg=p.heading,
            status=PanoStatus.READY,
            tiles=tiles[p.id],
        )
        for p in DEMO_PANOS
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
    units.append(
        Unit(
            id="u-tent",
            level_id="l1",
            name="Шатёр партнёров",
            category=UnitCategory.HALL,
            geometry=_rect(30, -26, 44, -14),
        )
    )
    paths = [
        PathLine(
            id="w-yard",
            geometry=LineStringGeometry(coordinates=[_ll(36, -1), _ll(40, -7), _ll(37, -13)]),
        )
    ]
    tours = [
        Tour(
            id="t-hackathon",
            name="Обход хакатона",
            description=(
                "Регистрация, шатёр партнёров во дворе, залы, кофе и менторы на втором этаже."
            ),
            stops=["p-registration", "p-tent", "p-stand-a1", "p-stage", "p-coffee", "p-mentors"],
        )
    ]
    return MapDocument(
        venue=Venue(id="demo", name="Демо-площадка хакатона", anchor=ANCHOR),
        levels=[Level(id="l1", name="1 этаж", ordinal=0), Level(id="l2", name="2 этаж", ordinal=1)],
        units=units,
        openings=openings,
        connectors=connectors,
        pois=pois,
        panos=panos,
        paths=paths,
        tours=tours,
        fixtures=furniture(),
    )


def _round(x: float, y: float, d: float) -> PolygonGeometry:
    ring = [
        _ll(x + d / 2 * math.cos(a), y + d / 2 * math.sin(a))
        for a in (i * math.pi / 8 for i in range(16))
    ]
    return PolygonGeometry(coordinates=[[*ring, ring[0]]])


def furniture() -> list[Fixture]:
    """Tables, seats, a stage, plants: the plan reads like a real venue, routes go around them."""
    items: list[tuple[str, str, FixtureKind, str, PolygonGeometry]] = [
        # Café: round tables and the bar.
        *[
            (f"f-cafe-{n}", "l1", FixtureKind.TABLE, "Столик", _round(x, y, 1.2))
            for n, (x, y) in enumerate([(22, 15), (28.5, 15), (22, 21), (28.5, 21)])
        ],
        ("f-cafe-bar", "l1", FixtureKind.COUNTER, "Бар", _rect(30.8, 16, 31.6, 20.5)),
        # Hall B: rows of seats with an aisle, the stage behind the speaker point.
        *[
            (f"f-seats-{n}", "l1", FixtureKind.SEATING, "Кресла", _rect(x0, y, x0 + 4, y + 0.6))
            for n, (x0, y) in enumerate([(3.5, 17.6), (12.5, 17.6), (3.5, 19), (12.5, 19)])
        ],
        ("f-stage", "l1", FixtureKind.STAGE, "Сцена", _rect(7, 22.6, 13, 23.8)),
        # Hall A: partner stands and a team table.
        ("f-stand-1", "l1", FixtureKind.BOOTH, "Стенд", _rect(11.5, 1, 13.5, 3)),
        ("f-table-a", "l1", FixtureKind.TABLE, "Стол", _rect(10.5, 6, 13.5, 7)),
        # Corridor: a sofa and plants along the walls.
        ("f-sofa", "l1", FixtureKind.SEATING, "Диван", _rect(23, 11, 25, 11.8)),
        *[
            (f"f-plant-{n}", "l1", FixtureKind.PLANT, "Растение", _round(x, 11.3, 0.7))
            for n, x in enumerate([1.5, 16, 38.5])
        ],
        # Lab upstairs: work tables.
        *[
            (f"f-lab-{n}", "l2", FixtureKind.TABLE, "Стол", _rect(x, y, x + 2.4, y + 1))
            for n, (x, y) in enumerate([(3, 19.5), (7, 19.5), (15, 15), (19, 19.5)])
        ],
    ]
    return [
        Fixture(id=fid, level_id=level, kind=kind, name=name, geometry=geometry)
        for fid, level, kind, name, geometry in items
    ]


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


def scene_source(scene: str) -> Path:
    """The downloaded scene, fetched on first use."""
    path = SCENES_DIR / f"{scene}.jpg"
    if not path.exists():
        SCENES_DIR.mkdir(parents=True, exist_ok=True)
        print(f"downloading {scene} ...")
        partial = path.with_suffix(".part")
        urllib.request.urlretrieve(SCENE_URL.format(scene), partial)
        partial.replace(path)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grid", action="store_true", help="synthetic grid in every panorama")
    parser.add_argument(
        "--keep-tiles", action="store_true", help="rebuild the plan only, reuse the pano tiles"
    )
    args = parser.parse_args()

    viewer_demo = ROOT / "apps" / "viewer" / "public" / "demo"
    tiles: dict[str, PanoTiles] = {}
    if args.keep_tiles:
        for pano in DEMO_PANOS:
            widths = sorted(int(d.name) for d in (viewer_demo / pano.id).iterdir() if d.is_dir())
            url = pano_url(pano.id)
            tiles[pano.id] = PanoTiles(
                base_url=url,
                preview_url=f"{url}/preview.webp",
                levels=[PanoTileLevel(width=w, cols=w // 512, rows=w // 1024) for w in widths],
            )
    for stale in [] if args.keep_tiles else viewer_demo.glob("pano-*"):
        shutil.rmtree(stale)
    with tempfile.TemporaryDirectory() as tmp:
        grid = Path(tmp) / "grid.png"
        if args.grid:
            cv2.imwrite(str(grid), grid_panorama())
        for pano in [] if args.keep_tiles else DEMO_PANOS:
            source = grid if args.grid else scene_source(pano.scene)
            url = pano_url(pano.id)
            levels = make_tiles(source, viewer_demo / pano.id, level_widths=(1024, 2048, 4096))
            tiles[pano.id] = PanoTiles(
                base_url=url, preview_url=f"{url}/preview.webp", levels=levels
            )
            print(f"{pano.id}: {pano.scene if not args.grid else 'grid'}")

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
    manifest = {
        "slug": "demo",
        "title": document.venue.name,
        "version": 1,
        "bundleUrl": "/demo/v1/bundle.json",
    }
    (viewer_demo / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"demo written: {viewer_demo}")


if __name__ == "__main__":
    main()
