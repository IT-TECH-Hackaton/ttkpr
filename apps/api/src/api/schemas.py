import uuid

from pydantic import ConfigDict, EmailStr, Field

from api.models import AccessMode, VersionStatus
from map_schema.models import CamelModel, LonLat, MapDocument


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
