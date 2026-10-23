"""Upload validation and image re-encoding (strips EXIF/GPS and anything hidden in the file)."""

from fastapi import HTTPException, UploadFile, status

from api.config import get_settings

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
WEBP_MAGIC = b"RIFF"
# 16K equirect (16384x8192) fits; a decompression bomb (46000x46000 grey JPEG < 10 MB) does not.
MAX_PIXELS = 140_000_000


async def read_limited(file: UploadFile, max_mb: int | None = None) -> bytes:
    limit = (max_mb or get_settings().max_upload_mb) * 1024 * 1024
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(1024 * 1024):
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
