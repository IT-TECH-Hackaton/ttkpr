import json
from pathlib import Path

from map_schema import MapDocument

DEMO = Path(__file__).parents[3] / "fixtures" / "demo-map.json"


def test_demo_map_is_valid() -> None:
    doc = MapDocument.model_validate_json(DEMO.read_text(encoding="utf-8"))
    assert doc.levels
    assert all(unit.level_id in {level.id for level in doc.levels} for unit in doc.units)


def test_serializes_camel_case() -> None:
    doc = MapDocument.model_validate_json(DEMO.read_text(encoding="utf-8"))
    dumped = json.loads(doc.model_dump_json(by_alias=True))
    assert "schemaVersion" in dumped
    assert "headingDeg" in dumped["panos"][0]
