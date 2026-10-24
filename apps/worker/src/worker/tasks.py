"""Celery tasks. Names are the contract with apps/api (it enqueues by name via send_task)."""

import logging
import tempfile
from collections.abc import Callable
from pathlib import Path

import cv2
from celery.exceptions import SoftTimeLimitExceeded

from map_schema.models import PanoTiles
from worker import db
from worker.celery_app import app
from worker.config import MEDIA_URL, storage_path
from worker.pano_video import stitch_video_file
from worker.plan_import import PlanImportError, recognize_file
from worker.room import RoomError
from worker.scan import scan_video_file
from worker.sfm import SfmFailed, SfmUnavailable
from worker.stitch import Frame, StitchResult, stitch
from worker.tiles import make_tiles
from worker.video import OrientationTrack, VideoError, find_video

log = logging.getLogger(__name__)

TILE_LEVELS = (1024, 2048, 4096)
TOO_LONG = "обработка заняла слишком много времени — снимите видео короче"


def _publish_tiles(pano_id: str, source_key: str) -> dict[str, object]:
    tiles_key = f"panos/{pano_id}/tiles"
    levels = make_tiles(storage_path(source_key), storage_path(tiles_key), level_widths=TILE_LEVELS)
    tiles = PanoTiles(
        base_url=f"{MEDIA_URL}/{tiles_key}",
        preview_url=f"{MEDIA_URL}/{tiles_key}/preview.webp",
        levels=levels,
    )
    return tiles.model_dump(mode="json", by_alias=True)


def _reporter(save: Callable[[int], None], start: int, span: int) -> Callable[[float], None]:
    """Progress 0..1 of a stage -> start..start+span percent, written every 5%."""
    last = [start]

    def progress(p: float) -> None:
        value = start + int(max(0.0, min(1.0, p)) * span)
        if value - last[0] >= 5:
            last[0] = value
            save(value)

    return progress


def _save_panorama(pano_id: str, result: StitchResult) -> None:
    source_key = f"panos/{pano_id}/source.jpg"
    target = storage_path(source_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(target), result.equirect, [cv2.IMWRITE_JPEG_QUALITY, 92])
    db.mark_ready(pano_id, _publish_tiles(pano_id, source_key), result.report)


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
        progress = _reporter(lambda v: db.set_progress(pano_id, v), 5, 85)
        result = stitch(
            frames, fov_deg=meta.get("fovDeg"), out_width=TILE_LEVELS[-1], progress=progress
        )
        _save_panorama(pano_id, result)
        log.info("panorama %s ready: %s", pano_id, result.report)
    except Exception as exc:
        log.exception("stitching failed for %s", pano_id)
        db.mark_failed(pano_id, f"Не удалось склеить панораму: {exc}")
        raise


@app.task(name="worker.tasks.stitch_video", soft_time_limit=1200, time_limit=1300)
def stitch_video(pano_id: str) -> None:
    """captures/{id}/video.{mp4|webm|mov} (+ orientation.json) -> keyframes -> equirect -> tiles.

    The raw video is deleted once the panorama is ready (privacy, disk)."""
    capture_dir = storage_path(f"captures/{pano_id}")
    try:
        row = db.load_panorama(pano_id)
        meta = row["capture_meta"] or {}
        video = find_video(capture_dir)
        track = OrientationTrack.load(capture_dir / "orientation.json")
        db.set_progress(pano_id, 2)
        result = stitch_video_file(
            video,
            track,
            fov_deg=meta.get("fovDeg"),
            out_width=TILE_LEVELS[-1],
            progress=_reporter(lambda v: db.set_progress(pano_id, v), 2, 90),
        ).result
        _save_panorama(pano_id, result)
        video.unlink(missing_ok=True)
        log.info("video panorama %s ready: %s", pano_id, result.report)
    except SoftTimeLimitExceeded:
        db.mark_failed(pano_id, f"Не удалось склеить панораму из видео: {TOO_LONG}")
        raise
    except Exception as exc:
        log.exception("video stitching failed for %s", pano_id)
        db.mark_failed(pano_id, f"Не удалось склеить панораму из видео: {exc}")
        raise


@app.task(name="worker.tasks.scan_room", soft_time_limit=1800, time_limit=1900)
def scan_room(scan_id: str) -> None:
    """scans/{id}/video.{mp4|webm|mov} (+ orientation.json) -> SfM -> floor outline (metres).

    Result: room_scans.result, see worker.room.RoomResult.to_json. The raw video is deleted once
    the scan is ready."""
    scan_dir = storage_path(f"scans/{scan_id}")
    try:
        row = db.load_scan(scan_id)
        video = find_video(scan_dir)
        track = OrientationTrack.load(scan_dir / "orientation.json")
        db.set_scan_progress(scan_id, 2)
        with tempfile.TemporaryDirectory(prefix="scan-") as tmp:
            result = scan_video_file(
                video,
                track,
                camera_height_m=float(row.get("camera_height_m") or 1.5),
                workdir=Path(tmp),
                progress=_reporter(lambda v: db.set_scan_progress(scan_id, v), 2, 95),
            )
        db.mark_scan_ready(scan_id, result.to_json())
        video.unlink(missing_ok=True)
        log.info(
            "room scan %s ready: %.1f m², confidence %.2f",
            scan_id,
            result.area_m2,
            result.confidence,
        )
    except SoftTimeLimitExceeded:
        db.mark_scan_failed(scan_id, f"Не удалось построить комнату: {TOO_LONG}")
        raise
    except (VideoError, RoomError, SfmFailed, SfmUnavailable) as exc:
        log.warning("room scan %s failed: %s", scan_id, exc)
        db.mark_scan_failed(scan_id, str(exc))
        raise
    except Exception as exc:
        log.exception("room scan failed for %s", scan_id)
        db.mark_scan_failed(scan_id, f"Не удалось построить комнату по видео: {exc}")
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


@app.task(name="worker.tasks.recognize_plan", soft_time_limit=900, time_limit=1000)
def recognize_plan(job_id: str) -> None:
    """plans/{id}/source (image or PDF) -> rooms, doors, stairs, floors (plan_imports.result).

    Every page is also saved as a WebP underlay in maps/{map_id}/assets/ (public, like uploaded
    plan images); the source file itself is never served and is deleted once done."""
    try:
        row = db.load_plan_import(job_id)
        source = storage_path(row["source_key"])
        db.set_plan_import_progress(job_id, 3)
        result, images = recognize_file(
            source, progress=_reporter(lambda v: db.set_plan_import_progress(job_id, v), 3, 90)
        )
        for page, image in zip(result["pages"], images, strict=True):
            key = f"maps/{row['map_id']}/assets/plan-{job_id}-{page['sourcePage']}.webp"
            ok, data = cv2.imencode(".webp", image, [cv2.IMWRITE_WEBP_QUALITY, 82])
            if not ok:
                raise PlanImportError("Не удалось сохранить страницу плана")
            target = storage_path(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data.tobytes())
            page["imageUrl"] = f"{MEDIA_URL}/{key}"
        db.mark_plan_import_ready(job_id, result)
        source.unlink(missing_ok=True)
        log.info(
            "plan %s: %d pages, %d rooms",
            job_id,
            len(result["pages"]),
            sum(len(p["rooms"]) for p in result["pages"]),
        )
    except SoftTimeLimitExceeded:
        db.mark_plan_import_failed(job_id, "Распознавание заняло слишком много времени")
        raise
    except PlanImportError as exc:
        db.mark_plan_import_failed(job_id, str(exc))
    except Exception as exc:
        log.exception("plan recognition failed for %s", job_id)
        db.mark_plan_import_failed(job_id, f"Не удалось распознать план: {exc}")
        raise
