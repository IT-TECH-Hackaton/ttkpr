"""Upload validation: images are re-encoded (strips EXIF/GPS and anything hidden in the file),
videos are checked by signature and size and streamed to storage."""

import os
import secrets
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, BinaryIO

from fastapi import HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError
from starlette.datastructures import UploadFile

from api.config import get_settings
from api.schemas import OrientationTrack
from api.storage import get_storage

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
WEBP_MAGIC = b"RIFF"
# 16K equirect (16384x8192) fits; a decompression bomb (46000x46000 grey JPEG < 10 MB) does not.
MAX_PIXELS = 140_000_000

# WebM / Matroska (Chrome, Android) start with an EBML header; MP4 / MOV (Safari, iPhone) with
# an ISO BMFF 'ftyp' box at byte 4.
EBML_MAGIC = b"\x1a\x45\xdf\xa3"
# HEIC / AVIF photos are ISO BMFF too: refuse their brands, a photo is not a video.
IMAGE_BRANDS = frozenset(
    {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1", b"avif", b"avis"}
)
CHUNK = 1024 * 1024
# 20000 samples of {t, q} are ~2 MB of JSON.
MAX_ORIENTATION_MB = 4
# Video uploads are the heaviest requests: per client and map, plenty for walking room to room.
VIDEO_UPLOADS = 30
VIDEO_UPLOADS_WINDOW_S = 600
VIDEO_PARTS = {
    "file": "Video: WebM, MP4 or MOV (MediaRecorder), up to 300 MB",
    "orientation": 'Optional JSON file: {"samples": [{"t": seconds, "q": [w, x, y, z]}],'
    ' "fovDeg": number | null}, up to 20000 samples; q is camera -> world, OpenCV camera axes,'
    " world z up",
}


async def read_limited(file: UploadFile, max_mb: int | None = None) -> bytes:
    limit = (max_mb or get_settings().max_upload_mb) * 1024 * 1024
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(CHUNK):
        size += len(chunk)
        if size > limit:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Файл слишком большой")
        chunks.append(chunk)
    return b"".join(chunks)


def ensure_image(data: bytes, *, jpeg_only: bool = False) -> None:
    is_jpeg = data.startswith(JPEG_MAGIC)
    is_other = data.startswith(PNG_MAGIC) or (data[:4] == WEBP_MAGIC and data[8:12] == b"WEBP")
    if not is_jpeg and (jpeg_only or not is_other):
        expected = "JPEG" if jpeg_only else "JPEG, PNG или WebP"
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"Нужен файл {expected}")


def reencode_webp(data: bytes, max_side: int = 4096) -> tuple[bytes, int, int]:
    """Decode, auto-rotate, downscale and re-encode. Returns (webp, width, height)."""
    import pyvips

    image = _open(data)
    if image.hasalpha():
        image = image.flatten(background=[255, 255, 255])
    scale = min(1.0, max_side / max(image.width, image.height))
    if scale < 1.0:
        image = image.resize(scale)
    out = image.webpsave_buffer(Q=85, keep=pyvips.enums.ForeignKeep.NONE)
    return out, image.width, image.height


def reencode_jpeg(data: bytes, quality: int = 92) -> bytes:
    import pyvips

    image = _open(data)
    if image.hasalpha():
        image = image.flatten()
    return bytes(image.jpegsave_buffer(Q=quality, keep=pyvips.enums.ForeignKeep.NONE))


def _open(data: bytes):  # type: ignore[no-untyped-def]
    """Header first (cheap, lazy): refuse oversized images before any pixel is decoded."""
    import pyvips

    try:
        image = pyvips.Image.new_from_buffer(data, "", fail=True)
    except pyvips.Error as exc:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Не удалось прочитать изображение"
        ) from exc
    if image.width * image.height > MAX_PIXELS:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Изображение слишком большое")
    return image.autorot()


def video_container(head: bytes) -> str | None:
    """File extension by signature (first 12 bytes), or None if it is not a video we take."""
    if head.startswith(EBML_MAGIC):
        return "webm"
    if head[4:8] == b"ftyp" and head[8:12] not in IMAGE_BRANDS:
        return "mov" if head[8:12] == b"qt  " else "mp4"
    return None


def multipart_body(
    fields: type[BaseModel], files: dict[str, str], required_files: tuple[str, ...]
) -> dict[str, Any]:
    """OpenAPI for a multipart body the route parses itself (see video_form): the file parts
    plus the text fields of `fields`, so the generated client still gets the exact shape."""
    schema = fields.model_json_schema(by_alias=True)
    binary = {"type": "string", "contentMediaType": "application/octet-stream"}
    properties = {name: {**binary, "description": text} for name, text in files.items()}
    return {
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "title": fields.__name__,
                        "properties": properties | schema["properties"],
                        "required": [*required_files, *schema.get("required", [])],
                    }
                }
            },
        }
    }


@asynccontextmanager
async def video_form[F: BaseModel](
    request: Request, fields: type[F]
) -> AsyncIterator[tuple[F, UploadFile, UploadFile | None]]:
    """Reads a video upload: `file`, an optional `orientation` JSON file and the text fields.

    The route calls it after checking access: the body is parsed only now, so nobody can make
    the server spool 300 MB without the right to upload (FastAPI parses declared File/Form
    parameters before any check). The parser spools files to disk past 1 MB, BodyLimit
    (api.middleware) stops oversized bodies while they stream in, temp files go on exit.
    """
    async with request.form(max_files=2, max_fields=10, max_part_size=64 * 1024) as form:
        file = form.get("file")
        orientation = form.get("orientation")
        if not isinstance(file, UploadFile):
            raise RequestValidationError(
                [{"type": "missing", "loc": ("body", "file"), "msg": "Field required"}]
            )
        if orientation is not None and not isinstance(orientation, UploadFile):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Дорожку ориентации нужно прислать файлом JSON (поле orientation)",
            )
        values = {k: v for k, v in form.multi_items() if isinstance(v, str) and v != ""}
        try:
            parsed = fields.model_validate(values)
        except ValidationError as exc:
            raise RequestValidationError(
                [{**e, "loc": ("body", *e["loc"])} for e in exc.errors(include_url=False)]
            ) from exc
        yield parsed, file, orientation


async def check_video(file: UploadFile) -> str:
    """Signature and size of an uploaded video; returns its extension (webm | mp4 | mov)."""
    settings = get_settings()
    container = video_container(await file.read(16))
    await file.seek(0)
    if container is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Нужно видео WebM, MP4 или MOV")
    if file.size is not None and file.size > settings.max_video_mb * 1024 * 1024:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"Видео больше {settings.max_video_mb} МБ — снимите покороче",
        )
    return container


def _copy_limited(source: BinaryIO, target: Path, max_bytes: int) -> int:
    """Chunked copy into a temp file next to the target, renamed into place when complete."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    size = 0
    try:
        with temp.open("wb") as out:
            while chunk := source.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Видео слишком большое")
                out.write(chunk)
        os.replace(temp, target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return size


async def save_video(file: UploadFile, container: str, prefix: str) -> tuple[str, int]:
    """Copies a checked video to `{prefix}/video.{container}` without holding it in memory.
    Returns (storage key, size in bytes)."""
    key = f"{prefix}/video.{container}"
    await file.seek(0)
    size = await run_in_threadpool(
        _copy_limited,
        file.file,
        get_storage().path(key),
        get_settings().max_video_mb * 1024 * 1024,
    )
    return key, size


async def store_video(
    file: UploadFile, container: str, track: OrientationTrack | None, prefix: str
) -> dict[str, Any]:
    """Saves the video and its orientation.json under `prefix`; nothing stays on failure.
    Returns the keys for capture metadata."""
    storage = get_storage()
    try:
        video_key, size = await save_video(file, container, prefix)
        orientation_key = None
        if track is not None:
            orientation_key = f"{prefix}/orientation.json"
            data = track.model_dump_json(by_alias=True).encode()
            await run_in_threadpool(storage.put, orientation_key, data)
    except BaseException:
        discard(prefix)
        raise
    return {"video": video_key, "videoBytes": size, "orientation": orientation_key}


def discard(prefix: str) -> None:
    shutil.rmtree(get_storage().path(prefix), ignore_errors=True)


async def read_orientation(file: UploadFile) -> OrientationTrack:
    """The phone's orientation track, validated. Stored re-serialized (documented fields only,
    samples in time order), so the worker always reads exactly the documented shape."""
    data = await read_limited(file, max_mb=MAX_ORIENTATION_MB)
    try:
        track = OrientationTrack.model_validate_json(data)
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            'Неверная дорожка ориентации: нужен JSON {"samples": [{"t": секунды,'
            ' "q": [w, x, y, z]}], "fovDeg": число или null}, не больше 20000 отсчётов',
        ) from exc
    track.samples.sort(key=lambda sample: sample.t)
    return track
