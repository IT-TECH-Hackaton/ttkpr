from pathlib import Path

import pytest
import pyvips

from worker.tiles import make_tiles


def _equirect(path: Path, width: int) -> Path:
    image = pyvips.Image.black(width, width // 2, bands=3) + [40, 90, 160]  # noqa: RUF005
    image.cast("uchar").jpegsave(str(path))
    return path


def test_make_tiles_writes_all_levels(tmp_path: Path) -> None:
    source = _equirect(tmp_path / "pano.jpg", 2048)
    levels = make_tiles(source, tmp_path / "out", level_widths=(1024, 2048, 4096))

    assert [(lvl.width, lvl.cols, lvl.rows) for lvl in levels] == [(1024, 2, 1), (2048, 4, 2)]
    assert (tmp_path / "out" / "preview.webp").exists()
    assert len(list((tmp_path / "out" / "2048").glob("*.webp"))) == 8


def test_rejects_non_equirect(tmp_path: Path) -> None:
    path = tmp_path / "square.jpg"
    (pyvips.Image.black(512, 512, bands=3)).cast("uchar").jpegsave(str(path))
    with pytest.raises(ValueError, match="2:1"):
        make_tiles(path, tmp_path / "out")
