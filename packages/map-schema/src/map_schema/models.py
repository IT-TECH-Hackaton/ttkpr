"""Map document schema (IMDF-inspired). Source of truth for OpenAPI and generated TS types.

Compatibility rules:

- everything added after version 1 is optional, so older drafts and published bundles stay valid
  (validating an old document upgrades it to the current version);
- new fields are left out of the JSON while they hold their default (``exclude_if``): maps that
  do not use a feature do not pay for it in bundle size, and old documents dump unchanged;
- the document is user input published to visitors: texts are length-limited and free of control
  characters, URLs are http(s) or our own ``/media/``, colours are ``#RRGGBB``, times carry an
  offset. Errors use ``map_*`` types with Russian messages for the editor.
"""

import itertools
import math
import re
from collections.abc import Callable, Iterable
from datetime import timedelta
from enum import StrEnum
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    GetCoreSchemaHandler,
    GetJsonSchemaHandler,
    StringConstraints,
    WithJsonSchema,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import CoreSchema, PydanticCustomError, core_schema

SCHEMA_VERSION = 2

LonLat = tuple[float, float]

# Effective defaults for windows (the fields stay empty in the document).
WINDOW_SILL_HEIGHT_M = 0.9
WINDOW_HEIGHT_M = 1.2
DEFAULT_TIMEZONE = "Europe/Moscow"


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# --- omitting defaults -----------------------------------------------------------------------


def _is_none(value: object) -> bool:
    return value is None


def _is_empty(value: object) -> bool:
    return not value


def _is_false(value: object) -> bool:
    return value is False


def _is_true(value: object) -> bool:
    return value is True


def _equals(default: object) -> Callable[[object], bool]:
    return lambda value: value == default


def _blank_to_none(value: object) -> object:
    """An emptied text field in the editor means "not set"."""
    return None if isinstance(value, str) and not value.strip() else value


# --- checked strings ---------------------------------------------------------------------------


class _Pattern:
    """Annotation: checks a regex with a readable error and publishes it in the JSON schema.

    Patterns are plain (no lookarounds, no flags), so the generated zod schemas use them as is.
    """

    def __init__(
        self,
        pattern: str,
        code: str,
        message: str,
        normalize: Callable[[str], str] | None = None,
    ) -> None:
        self.pattern = pattern
        self.regex = re.compile(pattern)
        self.code = code
        self.message = message
        self.normalize = normalize

    def check(self, value: str) -> str:
        if not self.regex.fullmatch(value):
            raise PydanticCustomError(self.code, self.message)
        return self.normalize(value) if self.normalize else value

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> CoreSchema:
        return core_schema.no_info_after_validator_function(self.check, handler(source))

    def __get_pydantic_json_schema__(
        self, schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        json_schema = handler(schema)
        json_schema["pattern"] = self.pattern
        return json_schema


class _Check:
    """Annotation: an extra Python-side check that has no JSON-schema counterpart."""

    def __init__(self, check: Callable[[str], str]) -> None:
        self.check = check

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> CoreSchema:
        return core_schema.no_info_after_validator_function(self.check, handler(source))


# C0 controls and DEL, plus the bidi overrides used to spoof text direction.
_BAD_INLINE = re.compile("[\x00-\x1f\x7f‭‮]")
_BAD_MULTILINE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‭‮]")


def _inline(value: str) -> str:
    if _BAD_INLINE.search(value):
        raise PydanticCustomError(
            "map_text", "Уберите из текста переносы строк и служебные символы"
        )
    return value


def _multiline(value: str) -> str:
    if _BAD_MULTILINE.search(value):
        raise PydanticCustomError("map_text", "Уберите из текста служебные символы")
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _line(max_length: int) -> Any:
    return StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length)


Name = Annotated[str, _line(120), _Check(_inline)]
ShortText = Annotated[str, _line(200), _Check(_inline)]
Hours = Annotated[str, _line(120), _Check(_inline)]
Tag = Annotated[str, _line(40), _Check(_inline)]
Description = Annotated[str, _line(2000), _Check(_multiline)]
ShortDescription = Annotated[str, _line(1000), _Check(_multiline)]
AnnouncementText = Annotated[str, _line(500), _Check(_multiline)]

OptName = Annotated[Name | None, BeforeValidator(_blank_to_none)]
OptShortText = Annotated[ShortText | None, BeforeValidator(_blank_to_none)]
OptHours = Annotated[Hours | None, BeforeValidator(_blank_to_none)]
OptDescription = Annotated[Description | None, BeforeValidator(_blank_to_none)]
OptShortDescription = Annotated[ShortDescription | None, BeforeValidator(_blank_to_none)]

ENTITY_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"
EntityId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=64),
    _Pattern(ENTITY_ID_PATTERN, "map_id", "Идентификатор: латиница, цифры и .-_: до 64 символов"),
]
LevelRef = Annotated[str, StringConstraints(min_length=1, max_length=200)]

COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"
Color = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=7),
    _Pattern(COLOR_PATTERN, "map_color", "Цвет — в формате #RRGGBB", str.lower),
]
OptColor = Annotated[Color | None, BeforeValidator(_blank_to_none)]

# Hosts without user info ("https://bank.ru@evil.example" is refused), our files by plain paths.
_HOST = r"[^\s/?#<>\"'`\\@:]+(:[0-9]{1,5})?"
_REST = r"([/?#][^\s<>\"'`\\]*)?"
_MEDIA = r"/media/[A-Za-z0-9._~/-]+"
LINK_URL_PATTERN = rf"^(https?://{_HOST}{_REST}|{_MEDIA})$"
# Images load inside an HTTPS page: plain http would be blocked as mixed content.
IMAGE_URL_PATTERN = rf"^(https://{_HOST}{_REST}|{_MEDIA})$"
_DOT_SEGMENT = re.compile(r"(^|/)\.{1,2}(/|$)")


def _no_dot_segments(value: str) -> str:
    if value.startswith("/media/") and _DOT_SEGMENT.search(value.removeprefix("/media/")):
        raise PydanticCustomError("map_url", "Ссылка на файл не может содержать «.» и «..»")
    return value


LinkUrl = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=2048),
    _Pattern(LINK_URL_PATTERN, "map_url", "Ссылка должна начинаться с https:// или /media/"),
    _Check(_no_dot_segments),
]
ImageUrl = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=2048),
    _Pattern(IMAGE_URL_PATTERN, "map_url", "Картинка — по ссылке https:// или из /media/"),
    _Check(_no_dot_segments),
]
OptLinkUrl = Annotated[LinkUrl | None, BeforeValidator(_blank_to_none)]
OptImageUrl = Annotated[ImageUrl | None, BeforeValidator(_blank_to_none)]

LANG_PATTERN = r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$"
LangCode = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=35),
    _Pattern(LANG_PATTERN, "map_lang", "Код языка — как en, zh или pt-BR", str.lower),
]

CATEGORY_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"
CategoryId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=32),
    _Pattern(CATEGORY_ID_PATTERN, "map_category", "Код категории: строчная латиница, цифры, - и _"),
]

EMOJI_PATTERN = r"^[^\s<>]{1,16}$"
Emoji = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=16),
    _Pattern(EMOJI_PATTERN, "map_emoji", "Эмодзи — один значок без пробелов"),
    _Check(_inline),
]
OptEmoji = Annotated[Emoji | None, BeforeValidator(_blank_to_none)]

PHONE_PATTERN = r"^\+?[0-9][0-9 ()-]{3,30}[0-9]$"
EMAIL_PATTERN = r"^[^\s@<>()\[\],;:\"]+@[^\s@<>()\[\],;:\"]+\.[^\s@<>()\[\],;:\"]+$"
TELEGRAM_PATTERN = r"^(@?[A-Za-z0-9_]{4,32}|https://t\.me/[A-Za-z0-9_]{4,32})$"


def _telegram_name(value: str) -> str:
    return value.removeprefix("https://t.me/").removeprefix("@")


Phone = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=32),
    _Pattern(PHONE_PATTERN, "map_phone", "Телефон — цифры, пробелы, скобки и дефисы, можно с +"),
]
Email = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=254),
    _Pattern(EMAIL_PATTERN, "map_email", "Проверьте email"),
]
Telegram = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=64),
    _Pattern(
        TELEGRAM_PATTERN,
        "map_telegram",
        "Telegram — имя пользователя (@name) или ссылка https://t.me/name",
        _telegram_name,
    ),
]

TIMEZONE_PATTERN = r"^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$"


def _known_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise PydanticCustomError(
            "map_timezone", "Неизвестный часовой пояс: нужен вида Europe/Moscow"
        ) from error
    return value


TimeZoneName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=64),
    _Pattern(TIMEZONE_PATTERN, "map_timezone", "Часовой пояс — вида Europe/Moscow"),
    _Check(_known_timezone),
]

# Published as a plain pattern rather than format: date-time, so generated validators accept
# offsets (zod's default iso datetime only takes "Z").
ISO_DATETIME_PATTERN = (
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?"
    r"([Zz]|[+-][0-9]{2}:?[0-9]{2})$"
)
IsoDateTime = Annotated[
    AwareDatetime,
    WithJsonSchema(
        {
            "type": "string",
            "pattern": ISO_DATETIME_PATTERN,
            "description": "ISO 8601 date-time with an offset, e.g. 2026-10-24T18:00:00+03:00",
        }
    ),
]


def _unique(items: Iterable[Any], what: str, key: Callable[[Any], str]) -> None:
    seen: set[str] = set()
    for item in items:
        value = key(item)
        if value in seen:
            raise PydanticCustomError(
                "map_duplicate", "{what}: повторяется «{value}»", {"what": what, "value": value}
            )
        seen.add(value)


# --- geometry ------------------------------------------------------------------------------------


class LineStringGeometry(CamelModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[LonLat] = Field(min_length=2)


class PolygonGeometry(CamelModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[LonLat]] = Field(min_length=1)


_EARTH_RADIUS_M = 6378137.0


def _checked_outline(geometry: PolygonGeometry, what: str, min_area_m2: float) -> PolygonGeometry:
    """One closed outline (closed here if needed) of 3..128 corners with a real area."""
    if len(geometry.coordinates) != 1:
        raise PydanticCustomError(
            "map_geometry", "{what}: нужен один контур без отверстий", {"what": what}
        )
    ring = list(geometry.coordinates[0])
    if len(ring) >= 2 and ring[0] != ring[-1]:
        ring.append(ring[0])
    if not 4 <= len(ring) <= 129:
        raise PydanticCustomError(
            "map_geometry", "{what}: в контуре от 3 до 128 углов", {"what": what}
        )
    for lon, lat in ring:
        if not (
            math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90
        ):
            raise PydanticCustomError(
                "map_geometry", "{what}: координаты вне допустимого диапазона", {"what": what}
            )
    lon0, lat0 = ring[0]
    k = math.cos(math.radians(lat0))
    xy = [
        (math.radians(lon - lon0) * _EARTH_RADIUS_M * k, math.radians(lat - lat0) * _EARTH_RADIUS_M)
        for lon, lat in ring
    ]
    area = abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in itertools.pairwise(xy))) / 2
    if area < min_area_m2:
        raise PydanticCustomError(
            "map_geometry", "{what}: контур слишком маленький", {"what": what}
        )
    return PolygonGeometry(coordinates=[ring])


# --- enums ---------------------------------------------------------------------------------------


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


class UnitAccess(StrEnum):
    """Who may enter. Routes go only through public rooms."""

    PUBLIC = "public"
    STAFF = "staff"
    CLOSED = "closed"


class Amenity(StrEnum):
    WIFI = "wifi"
    POWER = "power"
    ACCESSIBLE = "accessible"
    TOILET = "toilet"
    WATER = "water"
    FOOD = "food"
    QUIET = "quiet"
    KIDS = "kids"
    AC = "ac"
    PROJECTOR = "projector"
    PARKING = "parking"
    FIRSTAID = "firstaid"
    INFO = "info"


class OpeningCategory(StrEnum):
    DOOR = "door"
    PASSAGE = "passage"
    ENTRANCE = "entrance"
    WINDOW = "window"


class OpeningAccess(StrEnum):
    """Routes use only public openings; windows are never passable."""

    PUBLIC = "public"
    STAFF = "staff"
    EMERGENCY = "emergency"
    LOCKED = "locked"


class DoorKind(StrEnum):
    SINGLE = "single"
    DOUBLE = "double"
    SLIDING = "sliding"
    REVOLVING = "revolving"
    AUTOMATIC = "automatic"


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


class FixtureKind(StrEnum):
    TABLE = "table"
    BOOTH = "booth"
    STAGE = "stage"
    COUNTER = "counter"
    SEATING = "seating"
    SCREEN = "screen"
    PLANT = "plant"
    COLUMN = "column"
    SHELF = "shelf"
    KIOSK = "kiosk"
    OTHER = "other"


class AnnouncementKind(StrEnum):
    INFO = "info"
    WARNING = "warning"
    SUCCESS = "success"


# --- shared pieces -------------------------------------------------------------------------------


class Translation(CamelModel):
    """Name and description in another language; missing parts fall back to the original."""

    name: OptName = Field(None, exclude_if=_is_none)
    description: OptDescription = Field(None, exclude_if=_is_none)


# Keys are checked by `_clean_translations` (a key pattern in the schema would make the
# generated TS value type `unknown`).
Translations = dict[str, Translation]
_LANG = _Pattern(LANG_PATTERN, "map_lang", "Код языка — как en, zh или pt-BR", str.lower)


def _clean_translations(value: Translations) -> Translations:
    """Language codes checked and lower-cased; entries without any text dropped."""
    clean: Translations = {}
    for lang, translation in value.items():
        if translation.name is not None or translation.description is not None:
            clean[_LANG.check(lang.strip())] = translation
    return clean


def _translations_field() -> Any:
    return Field(
        default_factory=dict,
        max_length=5,
        exclude_if=_is_empty,
        description="Up to 5 languages, keyed by code (en, zh, ...)",
    )


# --- venue ---------------------------------------------------------------------------------------


class Branding(CamelModel):
    accent_color: OptColor = Field(None, exclude_if=_is_none)
    logo_url: OptImageUrl = Field(None, exclude_if=_is_none)
    cover_url: OptImageUrl = Field(None, exclude_if=_is_none)
    welcome_title: OptShortText = Field(None, exclude_if=_is_none)
    welcome_text: OptShortDescription = Field(None, exclude_if=_is_none)


class Announcement(CamelModel):
    """A banner for visitors, shown between `start` and `end` (open ends: always)."""

    id: EntityId
    text: AnnouncementText
    kind: AnnouncementKind = Field(AnnouncementKind.INFO, exclude_if=_equals("info"))
    start: IsoDateTime | None = Field(None, exclude_if=_is_none)
    end: IsoDateTime | None = Field(None, exclude_if=_is_none)
    poi_id: str | None = Field(
        None, max_length=200, exclude_if=_is_none, description="Tapping opens this place"
    )

    @model_validator(mode="after")
    def _ends_after_start(self) -> "Announcement":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise PydanticCustomError("map_time", "Объявление заканчивается раньше, чем начинается")
        return self


class CustomCategory(CamelModel):
    """An organizer's POI category, in addition to the built-in ones (same id overrides one)."""

    id: CategoryId
    label: Annotated[str, _line(60), _Check(_inline)]
    emoji: OptEmoji = Field(None, exclude_if=_is_none)
    color: OptColor = Field(None, exclude_if=_is_none)


class Venue(CamelModel):
    id: str
    name: str
    anchor: LonLat = Field(description="Origin of the local ENU frame (lon, lat)")
    address: str | None = None
    branding: Branding | None = Field(None, exclude_if=_is_none)
    announcements: list[Announcement] = Field(
        default_factory=list, max_length=20, exclude_if=_is_empty
    )
    categories: list[CustomCategory] = Field(
        default_factory=list, max_length=50, exclude_if=_is_empty
    )
    timezone: TimeZoneName = Field(
        DEFAULT_TIMEZONE,
        exclude_if=_equals(DEFAULT_TIMEZONE),
        description="IANA time zone of the venue: schedules and opening hours are shown in it",
    )
    languages: list[LangCode] = Field(
        default_factory=list,
        max_length=10,
        exclude_if=_is_empty,
        description="Languages offered to visitors, the one of the base texts first (ru if empty)",
    )

    @field_validator("branding")
    @classmethod
    def _drop_empty_branding(cls, value: Branding | None) -> Branding | None:
        return value if value is not None and value.model_dump(exclude_none=True) else None

    @field_validator("announcements")
    @classmethod
    def _unique_announcements(cls, value: list[Announcement]) -> list[Announcement]:
        _unique(value, "Объявления", lambda a: a.id)
        return value

    @field_validator("categories")
    @classmethod
    def _unique_categories(cls, value: list[CustomCategory]) -> list[CustomCategory]:
        _unique(value, "Категории", lambda c: c.id)
        return value

    @field_validator("languages")
    @classmethod
    def _dedupe_languages(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


class Building(CamelModel):
    id: str
    name: str


class Level(CamelModel):
    id: str
    building_id: str | None = None
    name: str
    ordinal: int = Field(description="0 = ground floor, negative = basement")
    height_m: float = 3.0


# --- rooms and walls -----------------------------------------------------------------------------


class Unit(CamelModel):
    id: str
    level_id: str
    name: str | None = None
    category: UnitCategory
    walkable: bool = True
    geometry: PolygonGeometry
    access: UnitAccess = Field(
        UnitAccess.PUBLIC,
        exclude_if=_equals("public"),
        description="staff / closed rooms are not walkable (like walkable: false)",
    )
    height_m: float | None = Field(
        None,
        ge=1.5,
        le=50,
        exclude_if=_is_none,
        description="Ceiling height; level height if unset",
    )
    color: OptColor = Field(None, exclude_if=_is_none, description="Fill on the plan")
    description: OptDescription = Field(None, exclude_if=_is_none)
    photos: list[ImageUrl] = Field(default_factory=list, max_length=10, exclude_if=_is_empty)
    capacity: int | None = Field(None, ge=1, le=1_000_000, exclude_if=_is_none)
    amenities: list[Amenity] = Field(default_factory=list, max_length=20, exclude_if=_is_empty)
    hours: OptHours = Field(
        None, exclude_if=_is_none, description="Opening hours as text, e.g. «Пн–Пт 9:00–18:00»"
    )
    translations: Translations = _translations_field()

    @field_validator("amenities")
    @classmethod
    def _dedupe_amenities(cls, value: list[Amenity]) -> list[Amenity]:
        return list(dict.fromkeys(value))

    @field_validator("translations")
    @classmethod
    def _drop_empty_translations(cls, value: Translations) -> Translations:
        return _clean_translations(value)


class Opening(CamelModel):
    id: str
    level_id: str
    category: OpeningCategory = OpeningCategory.DOOR
    geometry: LineStringGeometry
    access: OpeningAccess = Field(OpeningAccess.PUBLIC, exclude_if=_equals("public"))
    kind: DoorKind | None = Field(
        None, exclude_if=_is_none, description="Door type; revolving doors are not step-free"
    )
    width_m: float | None = Field(
        None,
        ge=0.3,
        le=30,
        exclude_if=_is_none,
        description="Clear width of a door when it differs from the drawing; < 0.8 m is not "
        "step-free",
    )
    sill_height_m: float | None = Field(
        None,
        ge=0,
        le=10,
        exclude_if=_is_none,
        description=f"Window only: sill above the floor (default {WINDOW_SILL_HEIGHT_M})",
    )
    height_m: float | None = Field(
        None,
        gt=0,
        le=10,
        exclude_if=_is_none,
        description=f"Window only: height of the glazing (default {WINDOW_HEIGHT_M})",
    )

    @model_validator(mode="after")
    def _fields_of_category(self) -> "Opening":
        # Leftovers after switching a window to a door (or back) mean nothing: drop them.
        if self.category == OpeningCategory.WINDOW:
            self.kind = None
            self.width_m = None
        else:
            self.sill_height_m = None
            self.height_m = None
        return self


class ConnectorPoint(CamelModel):
    level_id: str
    position: LonLat


class Connector(CamelModel):
    id: str
    kind: ConnectorKind
    name: str | None = None
    points: list[ConnectorPoint] = Field(min_length=2)


class Fixture(CamelModel):
    """Furniture and fittings inside a room (IMDF «fixture»): tables, booths, a stage, columns.

    Obstacles are holes in the floor for routing: routes go around them, never across.
    """

    id: EntityId
    level_id: LevelRef
    kind: FixtureKind
    name: OptName = Field(None, exclude_if=_is_none)
    geometry: PolygonGeometry
    height_m: float | None = Field(
        None, gt=0, le=50, exclude_if=_is_none, description="For 3D; a default per kind if unset"
    )
    obstacle: bool = Field(True, exclude_if=_is_true)
    color: OptColor = Field(None, exclude_if=_is_none)

    @field_validator("geometry")
    @classmethod
    def _outline(cls, value: PolygonGeometry) -> PolygonGeometry:
        return _checked_outline(value, "Препятствие", 0.01)


class Zone(CamelModel):
    """A labelled area inside rooms (фудкорт, зона тишины). Does not affect routes."""

    id: EntityId
    level_id: LevelRef
    name: Name
    color: OptColor = Field(None, exclude_if=_is_none)
    geometry: PolygonGeometry
    description: OptDescription = Field(None, exclude_if=_is_none)
    translations: Translations = _translations_field()

    @field_validator("geometry")
    @classmethod
    def _outline(cls, value: PolygonGeometry) -> PolygonGeometry:
        return _checked_outline(value, "Зона", 0.25)

    @field_validator("translations")
    @classmethod
    def _drop_empty_translations(cls, value: Translations) -> Translations:
        return _clean_translations(value)


# --- places --------------------------------------------------------------------------------------


class PoiLink(CamelModel):
    title: Annotated[str, _line(80), _Check(_inline)]
    url: LinkUrl


class PoiContacts(CamelModel):
    phone: Annotated[Phone | None, BeforeValidator(_blank_to_none)] = Field(
        None, exclude_if=_is_none
    )
    email: Annotated[Email | None, BeforeValidator(_blank_to_none)] = Field(
        None, exclude_if=_is_none
    )
    telegram: Annotated[Telegram | None, BeforeValidator(_blank_to_none)] = Field(
        None, exclude_if=_is_none, description="User name without @ (https://t.me/<name>)"
    )
    website: OptLinkUrl = Field(None, exclude_if=_is_none)


MAX_EVENT_DURATION = timedelta(days=31)


class PoiEvent(CamelModel):
    """A talk, a show, a session at this place. Times carry their offset."""

    id: EntityId
    title: ShortText
    start: IsoDateTime
    end: IsoDateTime
    description: OptShortDescription = Field(None, exclude_if=_is_none)
    speaker: OptName = Field(None, exclude_if=_is_none)

    @model_validator(mode="after")
    def _ends_after_start(self) -> "PoiEvent":
        if self.end <= self.start:
            raise PydanticCustomError(
                "map_time", "«{title}»: конец раньше начала", {"title": self.title}
            )
        if self.end - self.start > MAX_EVENT_DURATION:
            raise PydanticCustomError(
                "map_time", "«{title}»: событие длиннее 31 дня", {"title": self.title}
            )
        return self


class Poi(CamelModel):
    id: str
    level_id: str
    name: str
    category: str
    description: str | None = None
    position: LonLat
    height_m: float = Field(1.2, description="Height above floor, used for pano projection")
    photos: list[ImageUrl] = Field(default_factory=list, max_length=10, exclude_if=_is_empty)
    links: list[PoiLink] = Field(default_factory=list, max_length=5, exclude_if=_is_empty)
    contacts: PoiContacts | None = Field(None, exclude_if=_is_none)
    hours: OptHours = Field(None, exclude_if=_is_none)
    tags: list[Tag] = Field(default_factory=list, max_length=10, exclude_if=_is_empty)
    featured: bool = Field(False, exclude_if=_is_false, description="Shown first to visitors")
    events: list[PoiEvent] = Field(default_factory=list, max_length=50, exclude_if=_is_empty)
    translations: Translations = _translations_field()

    @field_validator("contacts")
    @classmethod
    def _drop_empty_contacts(cls, value: PoiContacts | None) -> PoiContacts | None:
        return value if value is not None and value.model_dump(exclude_none=True) else None

    @field_validator("tags")
    @classmethod
    def _dedupe_tags(cls, value: list[str]) -> list[str]:
        seen: dict[str, str] = {}
        for tag in value:
            seen.setdefault(tag.casefold(), tag)
        return list(seen.values())

    @field_validator("events")
    @classmethod
    def _unique_events(cls, value: list[PoiEvent]) -> list[PoiEvent]:
        _unique(value, "События", lambda e: e.id)
        return value

    @field_validator("translations")
    @classmethod
    def _drop_empty_translations(cls, value: Translations) -> Translations:
        return _clean_translations(value)


# --- panoramas and the rest ---------------------------------------------------------------------


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


class Tour(CamelModel):
    """A route the organizer prepared: an excursion, a stand tour, the way from the entrance."""

    id: str
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    stops: list[str] = Field(
        default_factory=list,
        max_length=30,
        description="POI ids in visiting order; visitors see tours with at least two",
    )
    avoid_stairs: bool = False


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
    tours: list[Tour] = []
    underlays: list[Underlay] = []
    fixtures: list[Fixture] = Field(default_factory=list, max_length=5000, exclude_if=_is_empty)
    zones: list[Zone] = Field(default_factory=list, max_length=1000, exclude_if=_is_empty)

    @field_validator("schema_version")
    @classmethod
    def _upgrade(cls, value: int) -> int:
        # Every later version only adds optional fields: an older document is a valid current one.
        return max(value, SCHEMA_VERSION)

    @field_validator("fixtures")
    @classmethod
    def _unique_fixtures(cls, value: list[Fixture]) -> list[Fixture]:
        _unique(value, "Препятствия", lambda f: f.id)
        return value

    @field_validator("zones")
    @classmethod
    def _unique_zones(cls, value: list[Zone]) -> list[Zone]:
        _unique(value, "Зоны", lambda z: z.id)
        return value
