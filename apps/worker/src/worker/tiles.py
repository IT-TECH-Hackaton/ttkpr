"""Equirect panorama -> preview + multi-resolution WebP tiles (PSV EquirectangularTilesAdapter)."""

from pathlib import Path

import pyvips

from map_schema.models import PanoTileLevel

TILE_SIZE = 512
PREVIEW_WIDTH = 512
DEFAULT_LEVEL_WIDTHS = (2048, 4096, 8192)
WEBP_QUALITY = 80

_NO_METADATA = pyvips.enums.ForeignKeep.NONE


def load_equirect(path: Path) -> pyvips.Image:
    image = pyvips.Image.new_from_file(str(path), access="sequential")
    image = image.autorot()
    if image.bands == 4:
        image = image.flatten()
    if abs(image.width / image.height - 2.0) > 0.01:
        raise ValueError(f"Expected a 2:1 equirectangular image, got {image.width}x{image.height}")
    return image


def make_tiles(
    source: Path,
    out_dir: Path,
    level_widths: tuple[int, ...] = DEFAULT_LEVEL_WIDTHS,
) -> list[PanoTileLevel]:
    """Writes {out_dir}/preview.webp and {out_dir}/{width}/{row}_{col}.webp. Strips all metadata."""
    image = load_equirect(source).copy_memory()
    out_dir.mkdir(parents=True, exist_ok=True)

    preview = image.resize(PREVIEW_WIDTH / image.width)
    preview.webpsave(str(out_dir / "preview.webp"), Q=WEBP_QUALITY, keep=_NO_METADATA)

    levels: list[PanoTileLevel] = []
    for width in level_widths:
        if width > image.width:
            break
        level_image = image.resize(width / image.width) if width != image.width else image
        cols, rows = width // TILE_SIZE, width // 2 // TILE_SIZE
        level_dir = out_dir / str(width)
        level_dir.mkdir(exist_ok=True)
        for row in range(rows):
            for col in range(cols):
                tile = level_image.crop(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE)
                tile.webpsave(
                    str(level_dir / f"{row}_{col}.webp"), Q=WEBP_QUALITY, keep=_NO_METADATA
                )
        levels.append(PanoTileLevel(width=width, cols=cols, rows=rows))

    if not levels:
        raise ValueError(f"Source is smaller than the smallest level ({level_widths[0]} px)")
    return levels
