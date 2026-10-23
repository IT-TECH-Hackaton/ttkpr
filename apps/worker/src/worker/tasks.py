"""Celery tasks. Names are the contract with apps/api (it enqueues by name via send_task)."""

import logging

import cv2

from map_schema.models import PanoTiles
from worker import db
from worker.celery_app import app
from worker.config import MEDIA_URL, storage_path
from worker.stitch import Frame, stitch
from worker.tiles import make_tiles

log = logging.getLogger(__name__)

TILE_LEVELS = (1024, 2048, 4096)


def _publish_tiles(pano_id: str, source_key: str) -> dict[str, object]:
    tiles_key = f"panos/{pano_id}/tiles"
    levels = make_tiles(storage_path(source_key), storage_path(tiles_key), level_widths=TILE_LEVELS)
    tiles = PanoTiles(
        base_url=f"{MEDIA_URL}/{tiles_key}",
        preview_url=f"{MEDIA_URL}/{tiles_key}/preview.webp",
        levels=levels,
    )
    return tiles.model_dump(mode="json", by_alias=True)


@app.task(name="worker.tasks.stitch_panorama")
def stitch_panorama(pano_id: str) -> None:
    """Phone frames + sensor quaternions -> equirect -> tiles. See worker.stitch."""
    try:
        row = db.load_panorama(pano_id)
        meta = row["capture_meta"] or {}
        frames_meta = meta.get("frames", {})
        frames: list[Frame] = []
        for index in sorted(frames_meta, key=int):
            image = cv2.imread(str(storage_path(f"captures/{pano_id}/{int(index):02d}.jpg")))
            if image is None:
                continue
            frames.append(Frame(image=image, quaternion=tuple(frames_meta[index]["quaternion"])))
        db.set_progress(pano_id, 5)

        last = [5]

        def progress(p: float) -> None:
            value = 5 + int(p * 85)
            if value - last[0] >= 5:
                last[0] = value
                db.set_progress(pano_id, value)

        result = stitch(
            frames, fov_deg=meta.get("fovDeg"), out_width=TILE_LEVELS[-1], progress=progress
        )
        source_key = f"panos/{pano_id}/source.jpg"
        target = storage_path(source_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(target), result.equirect, [cv2.IMWRITE_JPEG_QUALITY, 92])
        db.mark_ready(pano_id, _publish_tiles(pano_id, source_key), result.report)
        log.info("panorama %s ready: %s", pano_id, result.report)
    except Exception as exc:
        log.exception("stitching failed for %s", pano_id)
        db.mark_failed(pano_id, f"Не удалось склеить панораму: {exc}")
        raise


@app.task(name="worker.tasks.tile_panorama")
def tile_panorama(pano_id: str) -> None:
    """Uploaded equirect (panos/{id}/source.jpg) -> preview + tiles."""
    try:
        db.set_progress(pano_id, 10)
        db.mark_ready(pano_id, _publish_tiles(pano_id, f"panos/{pano_id}/source.jpg"), None)
    except Exception as exc:
        log.exception("tiling failed for %s", pano_id)
        db.mark_failed(pano_id, f"Не удалось обработать панораму: {exc}")
        raise


@app.task(name="worker.tasks.build_map_version")
def build_map_version(map_id: str, version_id: str) -> None:
    """Heavy publish steps (nav graph, visibility) will move here; publish is synchronous now."""
    raise NotImplementedError("map build is owned by the geo-routing agent")
