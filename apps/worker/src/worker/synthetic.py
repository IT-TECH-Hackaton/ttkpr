"""Synthetic captures with known ground truth, for tests and regression runs.

A textured equirect stands in for the room; perspective views of it at known rotations play the
phone camera (exact pinhole, pure rotation), and a sweep of views becomes a test video.
"""

import math
from pathlib import Path

import cv2
import numpy as np

from worker.stitch import look_rotation


def textured_equirect(width: int = 2048, seed: int = 7) -> np.ndarray:
    """Equirect with plenty of corners and colour variation (a 'room' with posters)."""
    rng = np.random.default_rng(seed)
    height = width // 2
    base = cv2.resize(
        rng.integers(40, 220, (16, 32, 3), dtype=np.uint8),
        (width, height),
        interpolation=cv2.INTER_CUBIC,
    )
    for _ in range(700 * width // 2048):
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        size = int(rng.integers(6, 40))
        if rng.random() < 0.5:
            cv2.rectangle(base, (x, y), (x + size, y + size // 2), color, -1)
        else:
            cv2.circle(base, (x, y), size // 2, color, 2)
    for i in range(120 * width // 2048):
        x, y = int(rng.integers(0, width - 80)), int(rng.integers(20, height))
        cv2.putText(base, f"R{i}", (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    return base


def render_view(
    scene: np.ndarray, rotation: np.ndarray, focal: float, size: tuple[int, int]
) -> np.ndarray:
    """Pinhole view (size = (w, h)) of an equirect for a camera -> world rotation."""
    w, h = size
    sh, sw = scene.shape[:2]
    us, vs = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    cam = np.stack([(us - (w - 1) / 2) / focal, (vs - (h - 1) / 2) / focal, np.ones_like(us)], -1)
    world = cam @ rotation.T
    world /= np.linalg.norm(world, axis=-1, keepdims=True)
    yaw = np.arctan2(world[..., 0], world[..., 1])
    pitch = np.arcsin(np.clip(world[..., 2], -1, 1))
    map_x = ((yaw / (2 * math.pi) + 0.5) * sw - 0.5).astype(np.float32)
    map_y = ((0.5 - pitch / math.pi) * sh - 0.5).astype(np.float32)
    return cv2.remap(scene, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def sweep(
    rings: tuple[float, ...] = (0.0, 55.0, -55.0),
    speed_deg_s: float = 40.0,
    fps: float = 10.0,
    roll_deg: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Turning in place: a full circle per ring (alternating direction), tilting between rings.

    Returns frame times (s) and camera -> world rotations (n, 3, 3)."""
    yaw_pitch: list[tuple[float, float]] = []
    step = speed_deg_s / fps
    yaw = 0.0
    for k, pitch in enumerate(rings):
        if k:
            previous = rings[k - 1]
            n_tilt = max(1, round(abs(pitch - previous) / step))
            yaw_pitch += [(yaw, previous + (pitch - previous) * i / n_tilt) for i in range(n_tilt)]
        direction = 1 if k % 2 == 0 else -1
        n_turn = round(360 / step)
        yaw_pitch += [(yaw + direction * 360 * i / n_turn, pitch) for i in range(n_turn)]
        yaw += direction * 360
    times = np.arange(len(yaw_pitch)) / fps
    rotations = np.stack([look_rotation(y, p, roll_deg) for y, p in yaw_pitch])
    return times, rotations


def write_video(path: Path, frames: list[np.ndarray], fps: float) -> Path:
    """MJPG in AVI: the one writer every OpenCV build has (production gets WebM/MP4)."""
    h, w = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter.fourcc(*"MJPG"), fps, (w, h))
    if not writer.isOpened():
        raise RuntimeError("OpenCV cannot write MJPG video")
    for frame in frames:
        writer.write(frame)
    writer.release()
    return path
