import uuid
from datetime import date, datetime

from pydantic import ConfigDict, EmailStr, Field

from api.models import AccessMode, MemberRole, PanoramaStatus, VersionStatus
from api.slugs import SLUG_PATTERN
from map_schema.models import CamelModel, LonLat, MapDocument, PanoTiles


class RegisterRequest(CamelModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(CamelModel):
    email: EmailStr
    password: str


class UserOut(CamelModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    name: str


class MapCreate(CamelModel):
    title: str = Field(min_length=1, max_length=200)
    anchor: LonLat = (37.6176, 55.7558)


class MapSummary(CamelModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    title: str
    access_mode: AccessMode
    draft_version: int
    published_number: int | None = None
    updated_at: datetime
    role: MemberRole = MemberRole.VIEWER
    permissions: list[str] = Field(default_factory=list, description="See api.permissions")


class MapUpdate(CamelModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    slug: str | None = Field(
        None,
        pattern=SLUG_PATTERN,
        description="Short link /m/{slug}: 3-32 latin letters, digits and dashes",
    )
    access_mode: AccessMode | None = None


class DraftOut(CamelModel):
    document: MapDocument
    version: int


class DraftSave(CamelModel):
    document: MapDocument
    version: int = Field(description="Version the client edited; 409 if it is stale")


class PublishOut(CamelModel):
    version_id: uuid.UUID
    number: int
    status: VersionStatus
    slug: str


class PublicManifest(CamelModel):
    slug: str
    title: str
    version: int
    bundle_url: str


class AssetOut(CamelModel):
    url: str
    width: int
    height: int


class CaptureTokenOut(CamelModel):
    token: str
    expires_at: int = Field(description="Unix time")


class PanoramaCreate(CamelModel):
    level_id: str = Field(min_length=1, max_length=64)
    position: LonLat
    heading_deg: float | None = Field(None, description="Compass heading of the first frame")
    title: str | None = Field(None, max_length=200)
    fov_deg: float | None = Field(None, gt=10, lt=170, description="FOV across the short side")
    frame_count: int = Field(ge=1, le=64)
    device: str | None = Field(None, max_length=300)


class PanoramaUpdate(CamelModel):
    level_id: str | None = Field(None, min_length=1, max_length=64)
    position: LonLat | None = None
    heading_deg: float | None = None
    title: str | None = Field(None, max_length=200)


class FrameMeta(CamelModel):
    quaternion: tuple[float, float, float, float] = Field(
        description="Camera -> world rotation [w, x, y, z]; OpenCV camera axes, world z up"
    )
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    timestamp_ms: float | None = None


class PanoramaOut(CamelModel):
    id: uuid.UUID
    map_id: uuid.UUID
    level_id: str
    position: LonLat
    heading_deg: float
    camera_height_m: float
    title: str | None
    source: str
    status: PanoramaStatus
    progress: int
    error: str | None
    frame_count: int
    tiles: PanoTiles | None
    quality: dict[str, float | int | str | None] | None
    created_at: datetime


class ProfileUpdate(CamelModel):
    name: str = Field(min_length=1, max_length=200)


class PasswordChange(CamelModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class MemberOut(CamelModel):
    user_id: uuid.UUID
    name: str
    email: str
    role: MemberRole
    is_you: bool


class MemberAdd(CamelModel):
    email: EmailStr
    role: MemberRole = MemberRole.EDITOR


class MemberUpdate(CamelModel):
    role: MemberRole


class InviteCreate(CamelModel):
    role: MemberRole = MemberRole.EDITOR


class InviteOut(CamelModel):
    token: str
    role: MemberRole
    expires_at: int


class InviteAccept(CamelModel):
    token: str


class StatDay(CamelModel):
    day: date
    views: int


class StatCount(CamelModel):
    key: str
    label: str
    count: int


class StatsOut(CamelModel):
    days: list[StatDay]
    totals: dict[str, int] = Field(
        description="Per kind: view, poi, route, pano, tour, search, miss"
    )
    top_pois: list[StatCount]
    top_routes: list[StatCount]
    top_tours: list[StatCount]
    searches: list[StatCount]
    misses: list[StatCount] = Field(description="Searches that found nothing")
    private: bool
