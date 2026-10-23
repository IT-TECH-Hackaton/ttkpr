"""Map document schema (IMDF-inspired). Source of truth for OpenAPI and generated TS types."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

SCHEMA_VERSION = 1

LonLat = tuple[float, float]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PointGeometry(CamelModel):
    type: Literal["Point"] = "Point"
    coordinates: LonLat


class LineStringGeometry(CamelModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[LonLat] = Field(min_length=2)


class PolygonGeometry(CamelModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[LonLat]] = Field(min_length=1)


class UnitCategory(StrEnum):
    ROOM = "room"
    CORRIDOR = "corridor"
    LOBBY = "lobby"
    HALL = "hall"
    RESTROOM = "restroom"
    STAIRS = "stairs"
    ELEVATOR = "elevator"
    OUTDOOR = "outdoor"
    NONPUBLIC = "nonpublic"


class OpeningCategory(StrEnum):
    DOOR = "door"
    PASSAGE = "passage"
    ENTRANCE = "entrance"


class ConnectorKind(StrEnum):
    STAIRS = "stairs"
    ELEVATOR = "elevator"
    ESCALATOR = "escalator"
    RAMP = "ramp"


class PanoStatus(StrEnum):
    UPLOADING = "uploading"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class Venue(CamelModel):
    id: str
    name: str
    anchor: LonLat = Field(description="Origin of the local ENU frame (lon, lat)")
    address: str | None = None


class Building(CamelModel):
    id: str
    name: str


class Level(CamelModel):
    id: str
    building_id: str | None = None
    name: str
    ordinal: int = Field(description="0 = ground floor, negative = basement")
    height_m: float = 3.0


class Unit(CamelModel):
    id: str
    level_id: str
    name: str | None = None
    category: UnitCategory
    walkable: bool = True
    geometry: PolygonGeometry


class Opening(CamelModel):
    id: str
    level_id: str
    category: OpeningCategory = OpeningCategory.DOOR
    geometry: LineStringGeometry


class ConnectorPoint(CamelModel):
    level_id: str
    position: LonLat


class Connector(CamelModel):
    id: str
    kind: ConnectorKind
    name: str | None = None
    points: list[ConnectorPoint] = Field(min_length=2)


class Poi(CamelModel):
    id: str
    level_id: str
    name: str
    category: str
    description: str | None = None
    position: LonLat
    height_m: float = Field(1.2, description="Height above floor, used for pano projection")


class PanoTileLevel(CamelModel):
    width: int
    cols: int
    rows: int


class PanoTiles(CamelModel):
    base_url: str = Field(
        description="Directory URL; tiles live at {baseUrl}/{width}/{row}_{col}.webp"
    )
    preview_url: str
    tile_size: int = 512
    levels: list[PanoTileLevel]


class Pano(CamelModel):
    id: str
    level_id: str
    position: LonLat
    heading_deg: float = Field(
        0.0, description="Azimuth (clockwise from north) of the image center, yaw = 0"
    )
    camera_height_m: float = 1.5
    status: PanoStatus = PanoStatus.PROCESSING
    tiles: PanoTiles | None = None


class PathLine(CamelModel):
    id: str
    level_id: str | None = Field(None, description="None = outdoor path")
    geometry: LineStringGeometry


class Underlay(CamelModel):
    """Raster plan placed under the drawing (uploaded image), per level."""

    id: str
    level_id: str
    url: str
    coordinates: list[LonLat] = Field(
        min_length=4,
        max_length=4,
        description="Corners: top-left, top-right, bottom-right, bottom-left",
    )
    opacity: float = Field(0.6, ge=0, le=1)


class MapDocument(CamelModel):
    schema_version: int = SCHEMA_VERSION
    venue: Venue
    buildings: list[Building] = []
    levels: list[Level] = []
    units: list[Unit] = []
    openings: list[Opening] = []
    connectors: list[Connector] = []
    pois: list[Poi] = []
    panos: list[Pano] = []
    paths: list[PathLine] = []
    underlays: list[Underlay] = []
