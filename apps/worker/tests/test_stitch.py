"""Stitching against ground truth: frames rendered from a known panorama with known rotations,
sensor readings perturbed by a few degrees and a wrong focal length, as on a real phone."""

import math

import cv2
import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from worker.stitch import Frame, look_rotation, matrix_to_quat, stitch

FRAME_W, FRAME_H = 360, 480  # portrait
TRUE_FOV = 55.0  # across the short side
TARGETS = (
    [(yaw, 0) for yaw in range(0, 360, 30)]
    + [(yaw, 45) for yaw in range(0, 360, 60)]
    + [(yaw, -45) for yaw in range(30, 390, 60)]
    + [(0, 90), (0, -90)]
)


def _scene(width: int = 2048) -> np.ndarray:
    """Equirect with plenty of corners and colour variation (a 'room' with posters)."""
    rng = np.random.default_rng(7)
    height = width // 2
    base = cv2.resize(
        rng.integers(40, 220, (16, 32, 3), dtype=np.uint8),
        (width, height),
        interpolation=cv2.INTER_CUBIC,
    )
    for _ in range(700):
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        size = int(rng.integers(6, 40))
        if rng.random() < 0.5:
            cv2.rectangle(base, (x, y), (x + size, y + size // 2), color, -1)
        else:
            cv2.circle(base, (x, y), size // 2, color, 2)
    for i in range(120):
        x, y = int(rng.integers(0, width - 80)), int(rng.integers(20, height))
        cv2.putText(base, f"R{i}", (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    return base


def _render_frame(scene: np.ndarray, rotation: np.ndarray, focal: float) -> np.ndarray:
    h, w = scene.shape[:2]
    us, vs = np.meshgrid(np.arange(FRAME_W, dtype=np.float32), np.arange(FRAME_H, dtype=np.float32))
    cam = np.stack(
        [(us - (FRAME_W - 1) / 2) / focal, (vs - (FRAME_H - 1) / 2) / focal, np.ones_like(us)], -1
    )
    world = cam @ rotation.T
    world /= np.linalg.norm(world, axis=-1, keepdims=True)
    yaw = np.arctan2(world[..., 0], world[..., 1])
    pitch = np.arcsin(np.clip(world[..., 2], -1, 1))
    map_x = ((yaw / (2 * math.pi) + 0.5) * w - 0.5).astype(np.float32)
    map_y = ((0.5 - pitch / math.pi) * h - 0.5).astype(np.float32)
    return cv2.remap(scene, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def _angle_deg(r: np.ndarray) -> float:
    return math.degrees(np.linalg.norm(Rotation.from_matrix(r).as_rotvec()))


@pytest.fixture(scope="module")
def capture() -> tuple[list[Frame], list[np.ndarray], float]:
    rng = np.random.default_rng(1)
    scene = _scene()
    focal = FRAME_W / 2 / math.tan(math.radians(TRUE_FOV) / 2)
    frames, truth = [], []
    for yaw, pitch in TARGETS:
        r_true = look_rotation(yaw, pitch, roll_deg=float(rng.normal(0, 2)))
        noise = Rotation.from_rotvec(rng.normal(0, math.radians(1.5), 3)).as_matrix()
        frames.append(
            Frame(
                image=_render_frame(scene, r_true, focal), quaternion=matrix_to_quat(noise @ r_true)
            )
        )
        truth.append(r_true)
    return frames, truth, focal


def test_bundle_adjustment_recovers_rotations_and_focal(capture) -> None:
    frames, truth, focal = capture
    result = stitch(frames, fov_deg=TRUE_FOV * 1.08, out_width=1024)

    # A common rotation between estimate and truth is unobservable; the spread is the error.
    errors = [r_est @ r_true.T for r_est, r_true in zip(result.rotations, truth, strict=True)]
    spread = max(_angle_deg(e @ errors[0].T) for e in errors)
    sensor_spread = max(
        _angle_deg(
            Rotation.from_quat([q[1], q[2], q[3], q[0]]).as_matrix()
            @ t.T
            @ truth[0]
            @ Rotation.from_quat(
                [
                    frames[0].quaternion[1],
                    frames[0].quaternion[2],
                    frames[0].quaternion[3],
                    frames[0].quaternion[0],
                ]
            )
            .as_matrix()
            .T
        )
        for q, t in ((f.quaternion, t) for f, t in zip(frames, truth, strict=True))
    )

    assert spread < 0.35, f"relative rotation error {spread:.2f}° (sensors: {sensor_spread:.2f}°)"
    assert abs(result.focal_px / focal - 1) < 0.02
    assert result.report["matchedPairs"] > 20
    assert result.report["coverage"] > 0.97
    assert result.equirect.shape == (512, 1024, 3)


def test_featureless_frames_fall_back_to_sensors() -> None:
    """White walls: no matches at all, the result still uses the sensor rotations."""
    flat = np.full((FRAME_H, FRAME_W, 3), 235, np.uint8)
    frames = [
        Frame(image=flat, quaternion=matrix_to_quat(look_rotation(yaw, 0)))
        for yaw in range(0, 360, 45)
    ]
    result = stitch(frames, fov_deg=TRUE_FOV, out_width=512)
    assert result.report["matches"] == 0
    assert result.report["framesOnSensorsOnly"] == len(frames)
    assert result.equirect.shape == (256, 512, 3)
