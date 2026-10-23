"""Short map addresses: /m/{slug}. Same rules as packages/map-core/src/slug.ts."""

import re
import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models import Map

# 3-32 chars (the column is String(32)): latin letters, digits and dashes, no dash at the ends.
SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$"
SLUG_MAX = 32
_SLUG_RE = re.compile(SLUG_PATTERN)
# /m/demo is the viewer's built-in demo (static files), never a real map.
RESERVED = frozenset({"demo", "studio"})

_RU = dict(
    zip(
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
        [
            "a",
            "b",
            "v",
            "g",
            "d",
            "e",
            "e",
            "zh",
            "z",
            "i",
            "y",
            "k",
            "l",
            "m",
            "n",
            "o",
            "p",
            "r",
            "s",
            "t",
            "u",
            "f",
            "h",
            "ts",
            "ch",
            "sh",
            "sch",
            "_",
            "y",
            "_",
            "e",
            "yu",
            "ya",
        ],
        strict=True,
    )
)


def slugify(text: str) -> str:
    """«Отель Сокол — 2 этаж» -> "otel-sokol-2-etazh"."""
    latin = "".join(_RU.get(ch, ch) for ch in text.lower()).replace("_", "")
    slug = re.sub(r"[^a-z0-9]+", "-", latin).strip("-")
    return slug[:SLUG_MAX].rstrip("-")


def is_valid(slug: str) -> bool:
    return bool(_SLUG_RE.match(slug)) and slug not in RESERVED


async def free_slug(db: AsyncSession, title: str) -> str:
    """A readable address from the title; a short suffix if it is taken; random as a last resort."""
    base = slugify(title)
    candidates = [base] if is_valid(base) else []
    if base:
        stem = base[: SLUG_MAX - 5].rstrip("-")
        candidates += [f"{stem}-{secrets.token_hex(2)}" for _ in range(3)]
    for candidate in candidates:
        if is_valid(candidate) and not await db.scalar(select(Map.id).where(Map.slug == candidate)):
            return candidate
    return f"map-{secrets.token_hex(6)}"
