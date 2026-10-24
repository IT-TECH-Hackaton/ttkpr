"""Panorama from a phone video: the organizer turns in place (three slow circles: at eye level,
tilted up, tilted down), the video is cut into sharp keyframes ~9° apart and stitched by
worker.stitch with the sensor track as priors, or with visual rotations when there is none."""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from worker.stitch import (
    Frame,
    StitchResult,
    estimate_focal,
    look_rotation,
    matrix_to_quat,
    stitch,
)
from worker.video import (
    FrameStats,
    OrientationTrack,
    VideoError,
    align,
    analyse,
    compose_chain,
    extract,
    frame_count,
    select_pano_keyframes,
)

log = logging.getLogger(__name__)

PANO_STEP_DEG = 9.0
MAX_PANO_KEYFRAMES = 90
MIN_PANO_KEYFRAMES = 8

Progress = Callable[[float], None]


@dataclass
class VideoStitch:
    result: StitchResult
    times: list[float]  # video time of every keyframe, same order as result.rotations


def _sensor_rotations(
    track: OrientationTrack, stats: FrameStats, report: dict[str, float | int | str]
) -> np.ndarray | None:
    track.fix_units(stats.duration)
    alignment = align(track, stats)
    covered = float(track.covers(stats.times + alignment.offset_s).mean())
    # A track that contradicts a video clearly showing rotations is wrong: trust the video.
    moving = np.linalg.norm(stats.rel_rotvec, axis=1) > np.radians(0.15)
    contradicts = alignment.score < 0.3 and float((stats.rot_valid & moving).mean()) > 0.4
    report["sensorMatch"] = round(alignment.score, 2)
    if covered < 0.8 or contradicts:
        log.warning(
            "orientation track unusable (covered %.2f, score %.2f)", covered, alignment.score
        )
        return None
    report["timeOffsetMs"] = round(alignment.offset_s * 1000)
    report["quarterTurns"] = alignment.quarter_turns
    return alignment.rotations(track, stats.times)


def stitch_video_file(
    path: Path,
    track: OrientationTrack | None,
    fov_deg: float | None = None,
    out_width: int = 4096,
    progress: Progress | None = None,
    step_deg: float = PANO_STEP_DEG,
    max_keyframes: int = MAX_PANO_KEYFRAMES,
) -> VideoStitch:
    report: dict[str, float | int | str] = {"source": "video"}
    fov = (track.fov_deg if track is not None else None) or fov_deg
    hint = frame_count(path)

    def on_frame(index: int) -> None:
        if progress and hint:
            progress(0.3 * min(1.0, index / hint))

    stats = analyse(path, fov, on_frame)
    rotations = None
    if track is not None and track.has_rotations:
        rotations = _sensor_rotations(track, stats, report)
    visual = rotations is None
    if rotations is None:
        rotations = compose_chain(stats.filled_rotvec(), look_rotation(0.0, 0.0))

    indices = select_pano_keyframes(rotations, stats.sharpness, step_deg, max_keyframes)
    if len(indices) < MIN_PANO_KEYFRAMES:
        raise VideoError(
            "Слишком мало кадров для панорамы: медленно повернитесь на месте на полный круг"
        )
    if progress:
        progress(0.32)
    images = extract(path, indices)
    scale = images[0].shape[1] / stats.size[0]
    focal = stats.focal_px * scale
    if visual:
        # The chained visual rotations scale with the focal error; fix it before the chain
        # drifts by tens of degrees over a few turns.
        n = len(images)
        pairs = [(k, k + d) for d in (1, 2) for k in range(n - d)]
        measured = estimate_focal(images, pairs, focal)
        if measured is not None and 0.6 < measured / focal < 1.6:
            focal = measured
            rotations = compose_chain(stats.filled_rotvec(focal / scale), look_rotation(0.0, 0.0))
    frames = [
        Frame(image=image, quaternion=matrix_to_quat(rotations[i]))
        for image, i in zip(images, indices, strict=True)
    ]
    del images
    if progress:
        progress(0.38)
    result = stitch(
        frames,
        out_width=out_width,
        progress=(lambda p: progress(0.38 + 0.62 * p)) if progress else None,
        focal_px=focal,
        priors="visual" if visual else "sensors",
        max_neighbors=16 if visual else 12,
    )
    result.report.update(report)
    result.report.update(
        videoFrames=len(stats.times),
        keyframes=len(indices),
        videoSeconds=round(stats.duration, 1),
    )
    return VideoStitch(result=result, times=[float(stats.times[i]) for i in indices])
