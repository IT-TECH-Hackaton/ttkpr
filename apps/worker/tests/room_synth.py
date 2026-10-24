"""Synthetic sparse reconstruction of an L-shaped room (helpers for test_room.py).

What a SfM run on a real walk-around would give: few points on white walls, dense skirting and
wall-ceiling edges, a sparse floor and ceiling, furniture, a corridor seen through the door,
trees and a house seen through the window, noise and outliers, per-camera visibility; then an
arbitrary similarity transform (SfM frames have unknown scale and orientation).
"""

import math
from dataclasses import dataclass

import numpy as np
from scipy.spatial.transform import Rotation

from worker.stitch import look_rotation

# L-shaped room, metres: 6 x 3 plus 3 x 2 -> 24 m², 2.7 m high.
L_ROOM = np.array([[0, 0], [6, 0], [6, 3], [3, 3], [3, 5], [0, 5]], dtype=float)
HEIGHT = 2.7
DOOR = ((6.0, 1.0), (6.0, 1.9))  # east wall, 0.9 m
WINDOW = ((1.0, 5.0), (2.2, 5.0))  # north wall, 1.2 m


@dataclass
class SynthScene:
    points: np.ndarray
    centers: np.ndarray
    rotations: np.ndarray
    observations: list[np.ndarray]
    first_center: np.ndarray
    first_heading: np.ndarray  # unit 2D vector


def _cross2(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return np.asarray(u[..., 0] * v[..., 1] - u[..., 1] * v[..., 0])


def _segments_cross(p: np.ndarray, q: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Do segments p_i -> q_i (n, 2) properly cross segment a -> b?"""
    d1 = _cross2(b - a, p - a)
    d2 = _cross2(b - a, q - a)
    d3 = _cross2(q - p, a - p)
    d4 = _cross2(q - p, b - p)
    return np.asarray((d1 * d2 < -1e-12) & (d3 * d4 < -1e-12))


def _solid_walls() -> list[tuple[np.ndarray, np.ndarray]]:
    solid = []
    for k in range(len(L_ROOM)):
        a, b = L_ROOM[k], L_ROOM[(k + 1) % len(L_ROOM)]
        d = (b - a) / np.linalg.norm(b - a)
        cut = None
        for o in (DOOR, WINDOW):
            oa, ob = np.array(o[0]), np.array(o[1])
            if abs(float(_cross2(d, oa - a))) < 1e-9 and abs(float(_cross2(d, ob - a))) < 1e-9:
                cut = sorted((float((oa - a) @ d), float((ob - a) @ d)))
        if cut is None:
            solid.append((a, b))
        else:
            solid += [(a, a + d * cut[0]), (a + d * cut[1], b)]
    return solid


def _path() -> list[tuple[float, float, float]]:
    """(x, y, heading°) along the walls ~0.8 m from them, the phone facing the opposite wall."""
    return [
        (0.8, 0.8, 20), (2.5, 0.8, 0), (4.2, 0.8, -10), (5.2, 0.8, -40), (5.2, 2.2, -90),
        (4.2, 2.2, -150), (2.2, 2.2, -120), (2.2, 3.3, -90), (2.2, 4.2, -150), (1.4, 4.2, 180),
        (0.8, 4.2, 150), (0.8, 2.5, 90), (0.8, 1.4, 60),
    ]  # fmt: skip


def make_scene(seed: int = 0) -> SynthScene:
    rng = np.random.default_rng(seed)
    pts = []
    for k in range(len(L_ROOM)):
        a, b = L_ROOM[k], L_ROOM[(k + 1) % len(L_ROOM)]
        length = float(np.linalg.norm(b - a))
        density = 40 if k == 0 else 4  # points per m²: posters on one wall, white paint elsewhere
        n = int(density * length * HEIGHT)
        t = rng.random(n)
        pts.append(np.column_stack([a + np.outer(t, b - a), rng.random(n) * HEIGHT]))
        for z0, z1 in ((0.0, 0.12), (HEIGHT - 0.08, HEIGHT)):  # skirting, wall-ceiling edge
            n = int(25 * length)
            t = rng.random(n)
            pts.append(np.column_stack([a + np.outer(t, b - a), z0 + rng.random(n) * (z1 - z0)]))
    for z, density in ((0.0, 12), (HEIGHT, 3)):  # floor, ceiling
        cand = rng.random((int(density * 30), 2)) * [6, 5]
        cand = cand[(cand[:, 1] <= 3) | (cand[:, 0] <= 3)]
        pts.append(np.column_stack([cand, np.full(len(cand), z)]))
    table = rng.random((150, 2)) * [1.2, 0.8] + [3.6, 1.0]
    pts.append(np.column_stack([table, np.full(len(table), 0.75)]))
    cabinet = np.column_stack([rng.random(200) + 0.8, rng.random(200) * 0.5, rng.random(200) * 1.8])
    corridor = np.column_stack(
        [np.full(300, 8.0), rng.random(300) * 6 - 1.5, rng.random(300) * HEIGHT]
    )
    outside = np.column_stack(
        [rng.random(400) * 14 - 4, 7 + rng.random(400) * 15, rng.random(400) * 8 - 3]
    )
    points = np.vstack([*pts, cabinet, corridor, outside])
    points += rng.normal(0, 0.015, points.shape)
    outliers = rng.random((int(0.02 * len(points)), 3)) * [10, 9, 4] - [2, 2, 0.5]
    points = np.vstack([points, outliers])

    centers, rotations = [], []
    path = _path()
    for k in range(len(path)):
        x0, y0, h0 = path[k]
        x1, y1, h1 = path[(k + 1) % len(path)]
        dh = (h1 - h0 + 180) % 360 - 180
        for s in np.linspace(0, 1, 5, endpoint=False):
            sweep = 25 * math.sin(2 * math.pi * (len(centers) / 7))
            centers.append([x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, 1.5 + rng.normal(0, 0.03)])
            rotations.append(
                look_rotation(
                    h0 + dh * s + sweep, float(rng.uniform(-12, 3)), float(rng.normal(0, 2))
                )
            )
    centers_a = np.asarray(centers)
    rotations_a = np.stack(rotations)

    # Visible: inside a portrait 40° x 65° frustum and not behind a solid wall (the corridor
    # and the outside are seen only through the door and the window). SfM keeps ~60%.
    solid = _solid_walls()
    tan_h, tan_v = math.tan(math.radians(20)), math.tan(math.radians(32.5))
    observations = []
    for c, r in zip(centers_a, rotations_a, strict=True):
        cam = (points - c) @ r
        z = cam[:, 2]
        ok = (z > 0.2) & (np.abs(cam[:, 0]) < tan_h * z) & (np.abs(cam[:, 1]) < tan_v * z)
        start = np.broadcast_to(c[:2], (len(points), 2))
        end = start + (points[:, :2] - start) * 0.995  # a point on a wall is not hidden by it
        for a, b in solid:
            ok &= ~_segments_cross(start, end, a, b)
        ok &= rng.random(len(points)) < 0.6
        observations.append(np.flatnonzero(ok))
    heading = math.radians(path[0][2])
    return SynthScene(
        points,
        centers_a,
        rotations_a,
        observations,
        centers_a[0],
        np.array([math.sin(heading), math.cos(heading)]),
    )


def random_similarity(scene: SynthScene, seed: int = 1) -> SynthScene:
    """The same scene as an SfM frame would give it: rotated, scaled and shifted."""
    rng = np.random.default_rng(seed)
    rot = Rotation.random(random_state=seed).as_matrix()
    scale = float(rng.uniform(0.2, 3.0))
    shift = rng.normal(0, 5, 3)
    return SynthScene(
        points=scale * scene.points @ rot.T + shift,
        centers=scale * scene.centers @ rot.T + shift,
        rotations=np.einsum("ab,nbc->nac", rot, scene.rotations),
        observations=scene.observations,
        first_center=scene.first_center,
        first_heading=scene.first_heading,
    )


def expected_polygon(scene: SynthScene) -> np.ndarray:
    """True outline in the output frame: first camera's foot, its heading as y, x to the right."""
    ey = scene.first_heading
    ex = np.array([ey[1], -ey[0]])
    rel = L_ROOM - scene.first_center[:2]
    return np.column_stack([rel @ ex, rel @ ey])
