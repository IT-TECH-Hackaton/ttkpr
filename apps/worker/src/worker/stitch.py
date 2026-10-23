"""Sensor-guided panorama stitching: phone frames + gyroscope rotations -> equirectangular.

1. Start from the sensor rotations (camera -> world) and an estimated focal length.
2. Match SIFT features only between frames that overlap according to the sensors, and
   reject matches far from where the sensors predict them (repetitive textures).
3. Bundle-adjust all rotations and one focal length. Each rotation has a prior that keeps it
   close to its sensor value, so frames of white walls without features simply stay there.
4. Gain compensation, feathered blending, hole filling (zenith/nadir).

Conventions (CLAUDE.md): OpenCV camera axes (x right, y down, z forward); world x east,
y north, z up. Equirect: yaw 0 in the image centre (= first frame's direction), yaw grows to
the right (clockwise seen from above), pitch +90 at the top row.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.spatial.transform import Rotation

MATCH_SIDE = 1000  # long side of images used for feature matching
MIN_INLIERS = 15
SENSOR_SIGMA_DEG = 3.0
PIXEL_SIGMA = 1.5

Progress = Callable[[float], None]


@dataclass
class Frame:
    image: np.ndarray  # BGR uint8, as shot (portrait or landscape)
    quaternion: tuple[float, float, float, float]  # camera -> world, [w, x, y, z]


@dataclass
class StitchResult:
    equirect: np.ndarray
    rotations: list[np.ndarray]  # refined camera -> world, re-referenced (frame 0 at yaw 0)
    focal_px: float
    report: dict[str, float | int | str] = field(default_factory=dict)


def quat_to_matrix(q: tuple[float, float, float, float]) -> np.ndarray:
    w, x, y, z = q
    return np.asarray(Rotation.from_quat([x, y, z, w]).as_matrix())


def matrix_to_quat(r: np.ndarray) -> tuple[float, float, float, float]:
    x, y, z, w = Rotation.from_matrix(r).as_quat()
    return float(w), float(x), float(y), float(z)


def look_rotation(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0) -> np.ndarray:
    """Camera -> world rotation for a camera looking at (yaw, pitch), horizon level."""
    psi, theta = math.radians(yaw_deg), math.radians(pitch_deg)
    forward = np.array(
        [math.sin(psi) * math.cos(theta), math.cos(psi) * math.cos(theta), math.sin(theta)]
    )
    right = np.array([math.cos(psi), -math.sin(psi), 0.0])
    down = np.cross(forward, right)
    r = np.column_stack([right, down, forward])
    if roll_deg:
        r = r @ Rotation.from_rotvec([0, 0, math.radians(roll_deg)]).as_matrix()
    return r


def _yaw(v: np.ndarray) -> float:
    return math.atan2(float(v[0]), float(v[1]))


def _rz(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def default_focal(width: int, height: int, fov_deg: float | None) -> float:
    """fov_deg is across the short side; without it assume a ~26 mm-equivalent main camera."""
    if fov_deg:
        return min(width, height) / 2 / math.tan(math.radians(fov_deg) / 2)
    return 0.75 * max(width, height)


# --- matching -------------------------------------------------------------------------------


@dataclass
class _Matches:
    i: np.ndarray  # frame index per match
    j: np.ndarray
    ui: np.ndarray  # (n, 2) pixel coords in matching scale
    uj: np.ndarray


def _overlapping_pairs(rotations: list[np.ndarray], max_angle: float) -> list[tuple[int, int]]:
    forwards = [r[:, 2] for r in rotations]
    pairs = []
    for a in range(len(rotations)):
        for b in range(a + 1, len(rotations)):
            angle = math.acos(float(np.clip(forwards[a] @ forwards[b], -1, 1)))
            if angle < max_angle:
                pairs.append((a, b))
    return pairs


def _project(
    r_world_to_cam: np.ndarray, rays: np.ndarray, f: float, cx: float, cy: float
) -> np.ndarray:
    cam = rays @ r_world_to_cam.T
    z = np.where(cam[:, 2] > 1e-6, cam[:, 2], np.nan)
    return np.column_stack([f * cam[:, 0] / z + cx, f * cam[:, 1] / z + cy])


def _match(
    grays: list[np.ndarray],
    rotations: list[np.ndarray],
    f: float,
    pairs: list[tuple[int, int]],
) -> tuple[_Matches, dict[tuple[int, int], int]]:
    sift = cv2.SIFT_create(nfeatures=1500)  # type: ignore[attr-defined]
    feats = [sift.detectAndCompute(g, None) for g in grays]
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    h, w = grays[0].shape
    cx, cy = (w - 1) / 2, (h - 1) / 2
    gate = max(40.0, 0.15 * max(w, h))  # how far from the sensor prediction a match may be

    all_i, all_j, all_ui, all_uj = [], [], [], []
    inliers_per_pair: dict[tuple[int, int], int] = {}
    for a, b in pairs:
        (ka, da), (kb, db) = feats[a], feats[b]
        if da is None or db is None or len(ka) < 8 or len(kb) < 8:
            continue
        knn = matcher.knnMatch(da, db, k=2)
        good = [m[0] for m in knn if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
        if len(good) < MIN_INLIERS:
            continue
        pa = np.array([ka[m.queryIdx].pt for m in good], dtype=np.float32)
        pb = np.array([kb[m.trainIdx].pt for m in good], dtype=np.float32)

        rays = np.column_stack([(pa[:, 0] - cx) / f, (pa[:, 1] - cy) / f, np.ones(len(pa))])
        predicted = _project(rotations[b].T, rays @ rotations[a].T, f, cx, cy)
        near = np.linalg.norm(predicted - pb, axis=1) < gate
        pa, pb = pa[near], pb[near]
        if len(pa) < MIN_INLIERS:
            continue
        _, mask = cv2.findHomography(pa, pb, cv2.RANSAC, 3.0)
        if mask is None:
            continue
        keep = mask.ravel().astype(bool)
        if keep.sum() < MIN_INLIERS:
            continue
        pa, pb = pa[keep], pb[keep]
        # Cap per pair so one textured pair does not dominate the adjustment.
        if len(pa) > 150:
            sel = np.linspace(0, len(pa) - 1, 150).astype(int)
            pa, pb = pa[sel], pb[sel]
        inliers_per_pair[(a, b)] = len(pa)
        all_i.append(np.full(len(pa), a))
        all_j.append(np.full(len(pa), b))
        all_ui.append(pa)
        all_uj.append(pb)

    if not all_i:
        empty = np.zeros((0, 2))
        return _Matches(np.zeros(0, int), np.zeros(0, int), empty, empty), inliers_per_pair
    # float64: finite-difference Jacobians in the adjustment need full precision.
    return (
        _Matches(
            np.concatenate(all_i),
            np.concatenate(all_j),
            np.vstack(all_ui).astype(np.float64),
            np.vstack(all_uj).astype(np.float64),
        ),
        inliers_per_pair,
    )


# --- bundle adjustment --------------------------------------------------------------------


def _adjust(
    rotations: list[np.ndarray], f0: float, matches: _Matches, size: tuple[int, int]
) -> tuple[list[np.ndarray], float, float]:
    """Returns refined rotations, focal length and RMS reprojection error in pixels."""
    n = len(rotations)
    if len(matches.i) == 0:
        return rotations, f0, float("nan")
    w, h = size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    r0 = np.stack(rotations)
    sensor_sigma = math.radians(SENSOR_SIGMA_DEG)

    def rays(u: np.ndarray, f: float) -> np.ndarray:
        v = np.column_stack([(u[:, 0] - cx) / f, (u[:, 1] - cy) / f, np.ones(len(u))])
        return np.asarray(v / np.linalg.norm(v, axis=1, keepdims=True))

    def unpack(x: np.ndarray) -> tuple[np.ndarray, float]:
        deltas = Rotation.from_rotvec(x[: 3 * n].reshape(n, 3)).as_matrix()
        return deltas @ r0, f0 * math.exp(x[-1])

    def residuals(x: np.ndarray) -> np.ndarray:
        rs, f = unpack(x)
        wi = np.einsum("nab,nb->na", rs[matches.i], rays(matches.ui, f))
        wj = np.einsum("nab,nb->na", rs[matches.j], rays(matches.uj, f))
        match_res = ((wi - wj) * f / PIXEL_SIGMA).ravel()
        prior = x[: 3 * n] / sensor_sigma
        focal_prior = np.array([x[-1] / 0.3])
        return np.concatenate([match_res, prior, focal_prior])

    m = len(matches.i)
    sparsity = lil_matrix((3 * m + 3 * n + 1, 3 * n + 1), dtype=int)
    rows = np.arange(m)
    for k in range(3):
        for c in range(3):
            sparsity[3 * rows + k, 3 * matches.i + c] = 1
            sparsity[3 * rows + k, 3 * matches.j + c] = 1
        sparsity[3 * rows + k, 3 * n] = 1
    for c in range(3 * n):
        sparsity[3 * m + c, c] = 1
    sparsity[3 * m + 3 * n, 3 * n] = 1

    solution = least_squares(
        residuals,
        np.zeros(3 * n + 1),
        jac_sparsity=sparsity,
        loss="soft_l1",
        f_scale=2.0,
        x_scale="jac",
        max_nfev=200,
    )
    rs, f = unpack(solution.x)
    match_part = residuals(solution.x)[: 3 * m].reshape(m, 3) * PIXEL_SIGMA
    rms = float(np.sqrt(np.mean(np.sum(match_part**2, axis=1))))
    return list(rs), f, rms


# --- rendering ----------------------------------------------------------------------------


def _footprint(r: np.ndarray, f: float, w: int, h: int, out_w: int) -> tuple[int, int, np.ndarray]:
    """Rows [r0, r1) and wrapped column indices of the equirect covered by a frame."""
    out_h = out_w // 2
    us, vs = np.meshgrid(np.linspace(0, w - 1, 9), np.linspace(0, h - 1, 9))
    cam = np.column_stack(
        [(us.ravel() - (w - 1) / 2) / f, (vs.ravel() - (h - 1) / 2) / f, np.ones(81)]
    )
    world = cam @ r.T
    world /= np.linalg.norm(world, axis=1, keepdims=True)
    pitch = np.degrees(np.arcsin(world[:, 2]))
    yaw = np.degrees(np.arctan2(world[:, 0], world[:, 1]))
    centre_yaw = math.degrees(_yaw(r[:, 2]))
    rel = (yaw - centre_yaw + 180) % 360 - 180
    top, bottom = pitch.max() + 2, pitch.min() - 2
    # Frames containing a pole see every yaw.
    forward_pitch = math.degrees(math.asin(float(np.clip(r[2, 2], -1, 1))))
    pole = (
        top >= 89
        or bottom <= -89
        or abs(forward_pitch) + math.degrees(math.atan(max(w, h) / 2 / f)) >= 89
    )
    r0 = max(0, int((90 - min(top, 90)) / 180 * out_h))
    r1 = min(out_h, math.ceil((90 - max(bottom, -90)) / 180 * out_h) + 1)
    if pole or rel.max() - rel.min() > 300:
        return r0, r1, np.arange(out_w)
    c_start = (centre_yaw + rel.min() - 2 + 180) / 360 * out_w
    width = (rel.max() - rel.min() + 4) / 360 * out_w
    cols = (int(c_start) + np.arange(math.ceil(width) + 1)) % out_w
    return r0, r1, np.unique(cols)


def _render(
    images: list[np.ndarray],
    rotations: list[np.ndarray],
    f: float,
    out_w: int,
    gains: np.ndarray | None = None,
    progress: Progress | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    out_h = out_w // 2
    acc = np.zeros((out_h, out_w, 3), np.float32)
    weight = np.zeros((out_h, out_w), np.float32)
    yaw_cols = (np.arange(out_w) + 0.5) / out_w * 2 * math.pi - math.pi
    pitch_rows = math.pi / 2 - (np.arange(out_h) + 0.5) / out_h * math.pi

    for k, (image, r) in enumerate(zip(images, rotations, strict=True)):
        h, w = image.shape[:2]
        r0, r1, cols = _footprint(r, f, w, h, out_w)
        yaw = yaw_cols[cols][None, :]
        pitch = pitch_rows[r0:r1][:, None]
        cos_p = np.cos(pitch)
        d = np.stack(
            [
                np.sin(yaw) * cos_p,
                np.cos(yaw) * cos_p,
                np.broadcast_to(np.sin(pitch), (r1 - r0, len(cols))),
            ],
            axis=-1,
        )
        cam = d @ r  # world -> camera for row vectors
        z = cam[..., 2]
        valid = z > 1e-3
        z_safe = np.where(valid, z, 1.0)
        u = (f * cam[..., 0] / z_safe + (w - 1) / 2).astype(np.float32)
        v = (f * cam[..., 1] / z_safe + (h - 1) / 2).astype(np.float32)
        inside = valid & (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
        if not inside.any():
            continue
        wx = np.clip(np.minimum(u, w - 1 - u) / (w / 2), 0, 1)
        wy = np.clip(np.minimum(v, h - 1 - v) / (h / 2), 0, 1)
        feather = np.where(inside, (wx * wy) ** 1.5 + 1e-6, 0).astype(np.float32)
        sampled = cv2.remap(image, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(
            np.float32
        )
        if gains is not None:
            sampled *= gains[k]
        acc[r0:r1, cols] += sampled * feather[..., None]
        weight[r0:r1, cols] += feather
        if progress:
            progress((k + 1) / len(images))
    return acc, weight


def _gains(images: list[np.ndarray], rotations: list[np.ndarray], f: float) -> np.ndarray:
    """OpenCV-style gain compensation from overlaps on a low-resolution equirect."""
    n = len(images)
    small_w = 512
    scale = 256 / max(images[0].shape[:2])
    smalls = [
        cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) for im in images
    ]
    layers = []
    for im, r in zip(smalls, rotations, strict=True):
        acc, wgt = _render([im], [r], f * scale, small_w)
        gray = acc.mean(axis=2) / np.maximum(wgt, 1e-6)
        layers.append((gray, wgt > 1e-4))
    alpha, beta = 0.01, 100.0
    a = np.zeros((n, n))
    b = np.zeros(n)
    for i in range(n):
        gi, mi = layers[i]
        for j in range(n):
            if i == j:
                continue
            gj, mj = layers[j]
            both = mi & mj
            count = float(both.sum())
            if count < 20:
                continue
            ii, ij = gi[both].mean(), gj[both].mean()
            b[i] += beta * count
            a[i, i] += beta * count + 2 * alpha * ii * ii * count
            a[i, j] -= 2 * alpha * ii * ij * count
    for i in range(n):
        if a[i, i] == 0:
            a[i, i], b[i] = 1.0, 1.0
    return np.clip(np.linalg.solve(a, b), 0.5, 2.0).astype(np.float32)


def _fill_holes(image: np.ndarray, holes: np.ndarray) -> np.ndarray:
    if not holes.any():
        return image
    h, w = holes.shape
    small_w = min(1024, w)
    small = cv2.resize(image, (small_w, small_w // 2), interpolation=cv2.INTER_AREA)
    small_holes = cv2.resize(
        holes.astype(np.uint8) * 255, (small_w, small_w // 2), interpolation=cv2.INTER_NEAREST
    )
    filled = cv2.inpaint(small, small_holes, 5, cv2.INPAINT_TELEA)
    filled = cv2.GaussianBlur(filled, (0, 0), 3)
    up = cv2.resize(filled, (w, h), interpolation=cv2.INTER_LINEAR)
    out = image.copy()
    out[holes] = up[holes]
    return out


# --- entry point --------------------------------------------------------------------------


def stitch(
    frames: list[Frame],
    fov_deg: float | None = None,
    out_width: int = 4096,
    progress: Progress | None = None,
) -> StitchResult:
    if len(frames) < 2:
        raise ValueError("Нужно хотя бы два кадра")
    sizes = {f.image.shape[:2] for f in frames}
    if len(sizes) != 1:
        raise ValueError("Кадры разного размера")
    h, w = frames[0].image.shape[:2]
    report: dict[str, float | int | str] = {"frames": len(frames)}

    sensor = [quat_to_matrix(f.quaternion) for f in frames]
    # Re-reference yaw so the first frame looks at the image centre; gravity is kept.
    align = _rz(_yaw(sensor[0][:, 2]))
    sensor = [align @ r for r in sensor]
    f0 = default_focal(w, h, fov_deg)

    scale = min(1.0, MATCH_SIDE / max(w, h))
    grays = [
        cv2.cvtColor(
            cv2.resize(f.image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA),
            cv2.COLOR_BGR2GRAY,
        )
        for f in frames
    ]
    long_fov = 2 * math.atan(max(w, h) / 2 / f0)
    pairs = _overlapping_pairs(sensor, max_angle=0.95 * long_fov)
    matches, per_pair = _match(grays, sensor, f0 * scale, pairs)
    if progress:
        progress(0.25)

    gh, gw = grays[0].shape
    rotations, f_small, rms = _adjust(sensor, f0 * scale, matches, (gw, gh))
    focal = f_small / scale
    connected = {k for pair in per_pair for k in pair}
    report.update(
        pairs=len(pairs),
        matchedPairs=len(per_pair),
        matches=len(matches.i),
        framesOnSensorsOnly=len(frames) - len(connected),
        rmsPx=round(rms / scale, 2) if not math.isnan(rms) else "n/a",
        focalPx=round(focal, 1),
        fovDeg=round(math.degrees(2 * math.atan(min(w, h) / 2 / focal)), 1),
    )
    if progress:
        progress(0.4)

    images = [f.image for f in frames]
    gains = _gains(images, rotations, focal)
    acc, wgt = _render(
        images,
        rotations,
        focal,
        out_width,
        gains,
        progress=(lambda p: progress(0.4 + 0.5 * p)) if progress else None,
    )
    holes = wgt < 1e-4
    equirect = np.clip(acc / np.maximum(wgt, 1e-6)[..., None], 0, 255).astype(np.uint8)
    equirect = _fill_holes(equirect, holes)
    report["coverage"] = round(float(1 - holes.mean()), 3)
    if progress:
        progress(1.0)
    return StitchResult(equirect=equirect, rotations=rotations, focal_px=focal, report=report)
