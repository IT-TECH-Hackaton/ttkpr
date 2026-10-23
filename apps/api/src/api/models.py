import uuid
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from api.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class AccessMode(StrEnum):
    PUBLIC = "public"
    LINK = "link"
    PASSWORD = "password"
    PRIVATE = "private"


class MemberRole(StrEnum):
    """Role of a user on one map. What each role may do lives in api.permissions."""

    OWNER = "owner"
    EDITOR = "editor"
    PHOTOGRAPHER = "photographer"
    VIEWER = "viewer"


class VersionStatus(StrEnum):
    BUILDING = "building"
    READY = "ready"
    FAILED = "failed"


class PanoramaStatus(StrEnum):
    UPLOADING = "uploading"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Map(Base):
    __tablename__ = "maps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    access_mode: Mapped[AccessMode] = mapped_column(String(16), default=AccessMode.LINK)
    draft: Mapped[dict[str, Any]] = mapped_column(JSONB)
    draft_version: Mapped[int] = mapped_column(Integer, default=1)
    published_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "map_versions.id",
            use_alter=True,
            ondelete="SET NULL",
            name="fk_maps_published_version_id",
        ),
        default=None,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class MapMember(Base):
    __tablename__ = "map_members"
    __table_args__ = (UniqueConstraint("map_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    map_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("maps.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[MemberRole] = mapped_column(String(16))


class MapVersion(Base):
    __tablename__ = "map_versions"
    __table_args__ = (UniqueConstraint("map_id", "number"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    map_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("maps.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[VersionStatus] = mapped_column(String(16), default=VersionStatus.BUILDING)
    bundle_url: Mapped[str | None] = mapped_column(String(500), default=None)
    # Immutable published document (draft + ready panoramas) served to visitors.
    bundle: Mapped[dict[str, Any] | None] = mapped_column(JSONB, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Panorama(Base):
    """Lives outside the draft document: frames, stitching and tiles have a server lifecycle.

    Ready panoramas are merged into the bundle at publish time.
    """

    __tablename__ = "panoramas"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    map_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("maps.id", ondelete="CASCADE"), index=True)
    level_id: Mapped[str] = mapped_column(String(64))
    lon: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    heading_deg: Mapped[float] = mapped_column(Float, default=0.0)
    camera_height_m: Mapped[float] = mapped_column(Float, default=1.5)
    title: Mapped[str | None] = mapped_column(String(200), default=None)
    source: Mapped[str] = mapped_column(String(16), default="capture")  # capture | upload
    status: Mapped[PanoramaStatus] = mapped_column(String(16), default=PanoramaStatus.UPLOADING)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    frame_count: Mapped[int] = mapped_column(Integer, default=0)
    capture_meta: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    tiles: Mapped[dict[str, Any] | None] = mapped_column(JSONB, default=None)
    quality: Mapped[dict[str, Any] | None] = mapped_column(JSONB, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class StatKind(StrEnum):
    VIEW = "view"  # the map was opened
    POI = "poi"  # a place card was opened; key = poi id
    ROUTE = "route"  # a route was built; key = "from>to"
    PANO = "pano"  # a panorama was opened; key = pano id
    TOUR = "tour"  # an organizer's tour was opened; key = tour id
    SEARCH = "search"  # a search was used; key = the query
    MISS = "miss"  # a search found nothing; key = the query


class MapStat(Base):
    """Anonymous daily counters for organizers: no visitor ids, no IP addresses."""

    __tablename__ = "map_stats"
    __table_args__ = (UniqueConstraint("map_id", "day", "kind", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    map_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("maps.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date)
    kind: Mapped[StatKind] = mapped_column(String(16))
    key: Mapped[str] = mapped_column(String(120), default="")
    count: Mapped[int] = mapped_column(Integer, default=0)
