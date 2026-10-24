"""Ray-cast renderer of a textured box room, for the SfM integration test (test_scan_sfm.py)."""

import math

import cv2
import numpy as np

from worker.stitch import look_rotation

PX_PER_M = 160  # texture resolution


def _texture(width_m: float, height_m: float, seed: int, base: int, busy: bool) -> np.ndarray:
    rng = np.random.default_rng(seed)
    w, h = round(width_m * PX_PER_M), round(height_m * PX_PER_M)
    image = np.full((h, w, 3), base, np.uint8)
    noise = rng.integers(-12, 12, (h // 8 + 1, w // 8 + 1, 1)).astype(np.int16)
    image = np.clip(image + cv2.resize(noise, (w, h))[..., None], 0, 255).astype(np.uint8)
    for _ in range(int((300 if busy else 25) * width_m * height_m)):
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        size = int(rng.integers(8, 60))
        kind = rng.random()
        if kind < 0.4:
            cv2.rectangle(image, (x, y), (x + size, y + size // 2), color, -1)
        elif kind < 0.7:
            cv2.circle(image, (x, y), size // 2, color, 3)
        else:
            cv2.putText(
                image, f"{rng.integers(0, 99)}", (x, y), cv2.FONT_HERSHEY_SIMPLEX, 1.2, color, 3
            )
    return image


class BoxRoom:
    """x in [0, width], y in [0, depth], z in [0, height] (metres)."""

    def __init__(self, width: float = 5.0, depth: float = 4.0, height: float = 2.6) -> None:
        self.size = (width, depth, height)
        # faces: (axis, value, texture, (u axis, v axis))
        self.faces = [
            (1, 0.0, _texture(width, height, 1, 200, True), (0, 2)),
            (1, depth, _texture(width, height, 2, 190, True), (0, 2)),
            (0, 0.0, _texture(depth, height, 3, 205, True), (1, 2)),
            (0, width, _texture(depth, height, 4, 195, True), (1, 2)),
            (2, 0.0, _texture(width, depth, 5, 120, True), (0, 1)),
            (2, height, _texture(width, depth, 6, 235, False), (0, 1)),
        ]

    def render(
        self, center: np.ndarray, rotation: np.ndarray, focal: float, size: tuple[int, int]
    ) -> np.ndarray:
        w, h = size
        us, vs = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
        rays = np.stack(
            [(us - (w - 1) / 2) / focal, (vs - (h - 1) / 2) / focal, np.ones_like(us)], -1
        )
        world = rays @ rotation.T
        best_t = np.full((h, w), np.inf)
        out = np.zeros((h, w, 3), np.uint8)
        for axis, value, texture, (ua, va) in self.faces:
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (value - center[axis]) / world[..., axis]
            hit = center + world * t[..., None]
            inside = np.isfinite(t) & (t > 1e-6)
            for k in range(3):
                if k != axis:
                    inside &= (hit[..., k] >= -1e-6) & (hit[..., k] <= self.size[k] + 1e-6)
            closer = inside & (t < best_t)
            if not closer.any():
                continue
            th, tw = texture.shape[:2]
            map_x = (hit[..., ua] * PX_PER_M).astype(np.float32)
            map_y = (
                (self.size[va] - hit[..., va]) * PX_PER_M if va == 2 else hit[..., va] * PX_PER_M
            ).astype(np.float32)
            sampled = cv2.remap(
                texture, np.clip(map_x, 0, tw - 1), np.clip(map_y, 0, th - 1), cv2.INTER_LINEAR
            )
            out[closer] = sampled[closer]
            best_t = np.where(closer, t, best_t)
        return out


def walk_path(
    room: BoxRoom, frames: int = 80, margin: float = 0.7
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Along the walls, phone upright at 1.5 m, facing the opposite wall, sweeping ±20°."""
    width, depth, _ = room.size
    corners = [
        (margin, margin),
        (width - margin, margin),
        (width - margin, depth - margin),
        (margin, depth - margin),
    ]
    headings = [0.0, -90.0, 180.0, 90.0]  # facing into the room from each wall
    poses = []
    perimeter = 2 * (width + depth - 4 * margin)
    for k in range(frames):
        s = k / frames * perimeter
        for side in range(4):
            a, b = np.array(corners[side]), np.array(corners[(side + 1) % 4])
            length = float(np.linalg.norm(b - a))
            if s <= length:
                xy = a + (b - a) * s / length
                heading = headings[side] + 20 * math.sin(k / 4)
                break
            s -= length
        center = np.array([xy[0], xy[1], 1.5])
        poses.append((center, look_rotation(heading, -8.0)))
    return poses
