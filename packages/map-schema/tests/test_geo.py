import json
from pathlib import Path

import pytest

from map_schema.geo import floor_point_from_pano, from_local, project_to_pano, to_local

VECTORS = json.loads(
    (Path(__file__).parents[3] / "fixtures" / "geo-vectors.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", VECTORS["toLocal"])
def test_to_local(case: dict) -> None:
    x, y = to_local(tuple(case["anchor"]), tuple(case["point"]))
    assert x == pytest.approx(case["expected"][0], abs=1e-3)
    assert y == pytest.approx(case["expected"][1], abs=1e-3)


@pytest.mark.parametrize("case", VECTORS["toLocal"])
def test_local_roundtrip(case: dict) -> None:
    anchor = tuple(case["anchor"])
    lon, lat = from_local(anchor, to_local(anchor, tuple(case["point"])))
    assert (lon, lat) == pytest.approx(tuple(case["point"]), abs=1e-9)


@pytest.mark.parametrize("case", VECTORS["projectToPano"], ids=lambda c: c["name"])
def test_project_to_pano(case: dict) -> None:
    yaw, pitch = project_to_pano(
        tuple(case["pano"]),
        case["heading"],
        case["cameraHeight"],
        tuple(case["target"]),
        case["targetHeight"],
    )
    assert yaw == pytest.approx(case["yaw"], abs=1e-9)
    assert pitch == pytest.approx(case["pitch"], abs=1e-9)


@pytest.mark.parametrize("case", VECTORS["floorFromPano"])
def test_floor_point_from_pano(case: dict) -> None:
    result = floor_point_from_pano(
        tuple(case["pano"]), case["heading"], case["cameraHeight"], case["yaw"], case["pitch"]
    )
    if case["expected"] is None:
        assert result is None
    else:
        assert result == pytest.approx(tuple(case["expected"]), abs=1e-9)
