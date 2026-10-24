"""Room scan: the organizer walks along the walls filming them (phone upright, floor and the
wall-ceiling edge in view), the video becomes ~60-110 keyframes, COLMAP recovers cameras and
sparse points, and worker.room turns them into a floor outline in metres."""

import logging
import math
from collections.abc import Callable
from pathlib import Path

import numpy as np

from worker.room import RoomResult, SceneInput, reconstruct_room
from worker.sfm import SfmResult, loop_pairs, run_sfm, write_images
from worker.video import (
    OrientationTrack,
    VideoError,
    align,
    analyse,
    extract,
    frame_count,
    select_scan_keyframes,
)

log = logging.getLogger(__name__)

SCAN_SIDE = 1280
MIN_SCAN_KEYFRAMES = 15

Progress = Callable[[float], None]


def gravity_in_sfm(sfm: SfmResult, sensor: np.ndarray) -> np.ndarray | None:
    """World up in the SfM frame from the phone's gravity: R_sfm · R_sensor^T · z per camera,
    averaged with outliers (>10° off) dropped."""
    if not len(sfm.frame_ids):
        return None
    ups = np.stack(
        [
            sfm.rotations[k] @ sensor[f].T @ np.array([0.0, 0.0, 1.0])
            for k, f in enumerate(sfm.frame_ids)
        ]
    )
    mean = ups.mean(axis=0)
    for _ in range(3):
        mean /= np.linalg.norm(mean)
        keep = ups @ mean > math.cos(math.radians(10))
        if keep.sum() < max(3, 0.3 * len(ups)):
            return None  # sensors and reconstruction disagree: rely on the cameras
        mean = ups[keep].mean(axis=0)
    return np.asarray(mean / np.linalg.norm(mean))


def scan_video_file(
    path: Path,
    track: OrientationTrack | None,
    camera_height_m: float,
    workdir: Path,
    progress: Progress | None = None,
    threads: int = 2,
) -> RoomResult:
    fov = track.fov_deg if track is not None else None
    hint = frame_count(path)

    def on_frame(index: int) -> None:
        if progress and hint:
            progress(0.15 * min(1.0, index / hint))

    stats = analyse(path, fov, on_frame)
    indices = select_scan_keyframes(stats.flow, stats.sharpness)
    if len(indices) < MIN_SCAN_KEYFRAMES:
        raise VideoError("Слишком короткое видео: медленно обойдите комнату вдоль стен")
    sensor = None
    if track is not None and track.has_rotations:
        track.fix_units(stats.duration)
        alignment = align(track, stats)
        times = stats.times[indices]
        if track.covers(times + alignment.offset_s).mean() >= 0.8:
            sensor = alignment.rotations(track, times)
    images = extract(path, indices, SCAN_SIDE)
    h, w = images[0].shape[:2]
    scale = w / stats.size[0]
    pairs = loop_pairs(images, sensor)
    names = write_images(images, workdir)
    del images  # COLMAP reads the files; keep memory for the mapper
    if progress:
        progress(0.2)
    sfm = run_sfm(
        workdir,
        names,
        (w, h),
        focal_px=stats.focal_px * scale,
        extra_pairs=pairs,
        threads=threads,
        progress=(lambda p: progress(0.2 + 0.7 * p)) if progress else None,
    )
    log.info(
        "sfm: %d/%d frames, %d points, reprojection %.2f px",
        len(sfm.frame_ids),
        len(indices),
        len(sfm.points),
        sfm.reprojection_error,
    )
    up = gravity_in_sfm(sfm, sensor) if sensor is not None else None
    scene = SceneInput(sfm.points, sfm.centers, sfm.rotations, sfm.observations, up)
    result = reconstruct_room(scene, camera_height_m, total_frames=len(indices))
    if progress:
        progress(1.0)
    return result
