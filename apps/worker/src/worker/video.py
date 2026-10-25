"""Phone video -> keyframes with camera rotations.

The phone records a video (MediaRecorder: WebM VP8/VP9 on Android Chrome, MP4 H.264 on iOS
Safari) and, when the browser gives motion sensors, an orientation track (``orientation.json``)::

    {"samples": [{"t": seconds from video start, "q": [w, x, y, z]}], "fovDeg": number | null}

``q`` is camera -> world exactly as for photo frames (docs/CONVENTIONS.md): OpenCV camera axes
of the image as decoded (x right, y down, z forward), world aligned with gravity (z up),
arbitrary azimuth.

One decoding pass measures every frame cheaply: timestamp, sharpness (variance of the Laplacian),
optical flow and the frame-to-frame rotation from KLT tracks. Keyframes are chosen from those
measurements, and a second pass keeps only them at working resolution, so memory does not grow with
the length of the video. The visual rotations also line the sensor track up with the video (clock
offset between MediaRecorder and deviceorientation, a frame rotated by 90° against the track) and
replace the track entirely when the phone gave no sensors.
"""

import json
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from worker.stitch import default_focal, kabsch

log = logging.getLogger(__name__)

VIDEO_EXTENSIONS = ("mp4", "webm", "mov")
WORK_SIDE = (
    1280  # long side of kept keyframes: ~17 px/deg for a phone camera, enough for 4K equirect
)
ANALYSIS_SIDE = 640  # long side for sharpness and KLT
MAX_DECODED_FRAMES = 20_000  # ~11 min at 30 fps: a guard against endless or corrupt streams
MAX_OFFSET_S = 0.6  # how far the sensor clock may be off the video clock

Progress = Callable[[float], None]


class VideoError(ValueError):
    """A problem with the recording itself; the message is shown to the organizer."""


# --- orientation track ---------------------------------------------------------------------


@dataclass
class OrientationTrack:
    times: np.ndarray  # (n,) seconds from the video start, increasing
    rotations: Rotation  # camera -> world per sample
    fov_deg: float | None = None

    @classmethod
    def parse(cls, data: Any) -> "OrientationTrack | None":
        """None when there are no usable samples (the phone gave no sensors)."""
        if not isinstance(data, dict):
            raise VideoError("orientation.json: ожидается объект с полем samples")
        fov = data.get("fovDeg")
        fov_deg = float(fov) if isinstance(fov, int | float) and 20 <= fov <= 150 else None
        samples = data.get("samples") or []
        if not isinstance(samples, list):
            raise VideoError("orientation.json: samples должен быть списком")
        times, quats = [], []
        for s in samples:
            if not isinstance(s, dict):
                continue
            t, q = s.get("t"), s.get("q")
            if not isinstance(t, int | float) or not isinstance(q, list) or len(q) != 4:
                continue
            qa = np.asarray(q, dtype=np.float64)
            norm = float(np.linalg.norm(qa))
            if not math.isfinite(t) or not np.all(np.isfinite(qa)) or norm < 1e-6:
                continue
            times.append(float(t))
            w, x, y, z = qa / norm
            quats.append([x, y, z, w])  # scipy order
        if len(times) < 2:
            if fov_deg is None:
                return None
            return cls(np.zeros(0), Rotation.identity(0), fov_deg)  # FOV only
        order = np.argsort(times, kind="stable")
        t_arr = np.asarray(times)[order]
        q_arr = np.asarray(quats)[order]
        keep = np.concatenate([[True], np.diff(t_arr) > 1e-6])  # Slerp needs strictly increasing
        return cls(t_arr[keep], Rotation.from_quat(q_arr[keep]), fov_deg)

    @classmethod
    def load(cls, path: Path) -> "OrientationTrack | None":
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise VideoError("orientation.json повреждён") from exc
        return cls.parse(data)

    @property
    def has_rotations(self) -> bool:
        return len(self.times) >= 2

    def fix_units(self, video_duration: float) -> None:
        """Tolerates milliseconds instead of seconds (an easy mistake on the phone side)."""
        if not self.has_rotations or video_duration <= 0:
            return
        span = float(self.times[-1] - self.times[0])
        if span > 20 * video_duration and 0.3 < span / 1000 / video_duration < 3:
            log.warning("orientation track looks like milliseconds, converting")
            self.times = self.times / 1000.0

    def at(self, t: np.ndarray) -> np.ndarray:
        """(n, 3, 3) camera -> world at times t (clamped to the track)."""
        clamped = np.clip(np.asarray(t, dtype=np.float64), self.times[0], self.times[-1])
        return np.asarray(Slerp(self.times, self.rotations)(clamped).as_matrix())

    def covers(self, t: np.ndarray, tolerance: float = 0.25) -> np.ndarray:
        return np.asarray((t >= self.times[0] - tolerance) & (t <= self.times[-1] + tolerance))


# --- rotations between frames ---------------------------------------------------------------


def rotation_ransac(
    a: np.ndarray, b: np.ndarray, threshold: float, iterations: int = 64, seed: int = 0
) -> tuple[np.ndarray, np.ndarray] | None:
    """Robust R with b ≈ R a (unit rays). Returns (R, inlier mask) or None.

    Two correspondences fix a rotation, so the minimal samples are tiny and all hypotheses are
    solved at once with a batched SVD. threshold is the chord distance (≈ angle in radians).
    """
    n = len(a)
    if n < 6:
        return None
    rng = np.random.default_rng(seed)
    i = rng.integers(0, n, iterations)
    j = rng.integers(0, n, iterations)
    j = np.where(i == j, (j + 1) % n, j)
    h = np.einsum("ka,kb->kab", a[i], b[i]) + np.einsum("ka,kb->kab", a[j], b[j])
    u, _, vt = np.linalg.svd(h)
    v = np.transpose(vt, (0, 2, 1))
    ut = np.transpose(u, (0, 2, 1))
    d = np.sign(np.linalg.det(v @ ut))
    d = np.where(d == 0, 1.0, d)
    fix = np.tile(np.eye(3), (iterations, 1, 1))
    fix[:, 2, 2] = d
    hyps = v @ fix @ ut  # (k, 3, 3)
    err = np.linalg.norm(np.einsum("kab,nb->kna", hyps, a) - b[None], axis=2)
    counts = (err < threshold).sum(axis=1)
    best = int(np.argmax(counts))
    inliers = err[best] < threshold
    if inliers.sum() < 6:
        return None
    r = kabsch(a[inliers], b[inliers])
    inliers = np.linalg.norm(a @ r.T - b, axis=1) < threshold
    if inliers.sum() < 6:
        return None
    return kabsch(a[inliers], b[inliers]), inliers


def rotation_angles(r0: np.ndarray, rs: np.ndarray) -> np.ndarray:
    """Angles (degrees) between rotation r0 (3, 3) and each of rs (n, 3, 3)."""
    trace = np.einsum("ab,nab->n", r0, rs)  # trace(r0^T r_i)
    return np.asarray(np.degrees(np.arccos(np.clip((trace - 1) / 2, -1.0, 1.0))))


def compose_chain(rel_rotvec: np.ndarray, start: np.ndarray) -> np.ndarray:
    """Absolute camera -> world rotations from frame-to-frame rotations.

    rel_rotvec[i] is the rotation mapping rays of frame i to rays of frame i-1 (row 0 unused):
    R_i = R_{i-1} · rel_i.
    """
    rel = Rotation.from_rotvec(rel_rotvec).as_matrix()
    out = np.empty((len(rel_rotvec), 3, 3))
    out[0] = start
    for k in range(1, len(rel)):
        out[k] = out[k - 1] @ rel[k]
    return out


# --- decoding -------------------------------------------------------------------------------


def find_video(directory: Path) -> Path:
    for ext in VIDEO_EXTENSIONS:
        path = directory / f"video.{ext}"
        if path.exists():
            return path
    raise VideoError("Видео не найдено — загрузите запись ещё раз")


def _open(path: Path) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
    if not cap.isOpened():
        raise VideoError("Не удалось прочитать видео: формат не поддерживается")
    return cap


def frame_count(path: Path) -> int:
    """Container's frame count; 0 when unknown (MediaRecorder WebM has no duration)."""
    cap = _open(path)
    try:
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    finally:
        cap.release()
    return int(count) if math.isfinite(count) and 0 < count < MAX_DECODED_FRAMES else 0


def _frames(path: Path) -> Any:
    """Yields (index, timestamp_s, BGR frame). Timestamps come from the container (VFR safe)."""
    cap = _open(path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        step = 1.0 / fps if fps and 1 <= fps <= 240 else 1 / 30
        last_t = -1.0
        index = 0
        while index < MAX_DECODED_FRAMES:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if not math.isfinite(t) or t <= last_t:
                t = last_t + step if last_t >= 0 else 0.0
            last_t = t
            yield index, t, frame
            index += 1
    finally:
        cap.release()


def _resize_long(image: np.ndarray, side: int) -> np.ndarray:
    h, w = image.shape[:2]
    scale = side / max(h, w)
    if scale >= 1:
        return image
    return cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


@dataclass
class FrameStats:
    """Cheap per-frame measurements from the first decoding pass."""

    times: np.ndarray  # (n,) seconds
    sharpness: np.ndarray  # (n,) variance of the Laplacian at analysis scale
    flow: np.ndarray  # (n,) median KLT displacement from frame i-1, fraction of the long side
    rel_rotvec: np.ndarray  # (n, 3) rotation mapping rays of frame i to frame i-1 (camera axes)
    rot_valid: np.ndarray  # (n,) the visual rotation of frame i was measured
    size: tuple[int, int]  # (width, height) as decoded
    focal_px: float  # focal (full-resolution pixels) assumed for the visual rotations

    @property
    def duration(self) -> float:
        return float(self.times[-1]) if len(self.times) else 0.0

    def rel_rotvec_for_focal(self, focal_px: float) -> np.ndarray:
        """First-order correction of the visual rotations for another focal length.

        Pan and tilt are measured as pixel shift / focal, so they scale with assumed/true focal;
        roll around the optical axis does not depend on it.
        """
        out = self.rel_rotvec.copy()
        out[:, :2] *= self.focal_px / focal_px
        return out

    def filled_rotvec(self, focal_px: float | None = None) -> np.ndarray:
        """Visual rotations with gaps (white walls, blur) filled by the neighbours' speed."""
        rv = self.rel_rotvec_for_focal(focal_px) if focal_px else self.rel_rotvec.copy()
        valid = self.rot_valid.copy()
        valid[0] = True
        if valid.all():
            return rv
        idx = np.arange(len(rv))
        dt = np.diff(self.times, prepend=self.times[0])
        dt[dt <= 0] = 1 / 30
        speed = rv / dt[:, None]
        for c in range(3):
            speed[~valid, c] = np.interp(idx[~valid], idx[valid], speed[valid, c])
        rv[~valid] = speed[~valid] * dt[~valid, None]
        rv[0] = 0
        return rv


def analyse(
    path: Path, fov_deg: float | None = None, on_frame: Callable[[int], None] | None = None
) -> FrameStats:
    """First pass: per-frame timestamp, sharpness, flow and visual rotation (KLT + RANSAC).

    fov_deg (across the short side) sets the focal assumed for the visual rotations."""
    times: list[float] = []
    sharp: list[float] = []
    flow: list[float] = []
    rotvecs: list[np.ndarray] = []
    valid: list[bool] = []
    size: tuple[int, int] | None = None
    prev_gray: np.ndarray | None = None
    prev_pts: np.ndarray | None = None
    fa = cx = cy = long_side = 0.0
    lk = {
        "winSize": (21, 21),
        "maxLevel": 3,
        "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
    }
    for index, t, frame in _frames(path):
        if size is None:
            h, w = frame.shape[:2]
            size = (w, h)
            f_full = default_focal(w, h, fov_deg)
            small_scale = min(1.0, ANALYSIS_SIDE / max(w, h))
            fa = f_full * small_scale
            long_side = max(w, h) * small_scale
        elif frame.shape[1::-1] != size:
            raise VideoError("Размер кадра меняется посреди видео — не поворачивайте телефон")
        gray = cv2.cvtColor(_resize_long(frame, ANALYSIS_SIDE), cv2.COLOR_BGR2GRAY)
        if index == 0:
            cy, cx = (gray.shape[0] - 1) / 2, (gray.shape[1] - 1) / 2
        times.append(t)
        sharp.append(float(cv2.Laplacian(gray, cv2.CV_32F).var()))
        moved, rotvec, ok = 0.0, np.zeros(3), False
        if prev_gray is not None:
            if prev_pts is None or len(prev_pts) < 120:
                prev_pts = cv2.goodFeaturesToTrack(
                    prev_gray, maxCorners=300, qualityLevel=0.01, minDistance=10, blockSize=7
                )
            if prev_pts is not None and len(prev_pts) >= 8:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, prev_pts, None, **lk)  # type: ignore[call-overload]
                back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev_gray, nxt, None, **lk)  # type: ignore[call-overload]
                good = (
                    (st.ravel() == 1)
                    & (st2.ravel() == 1)
                    & (np.linalg.norm((back - prev_pts).reshape(-1, 2), axis=1) < 1.0)
                )
                p0 = prev_pts.reshape(-1, 2)[good]
                p1 = nxt.reshape(-1, 2)[good]
                if len(p0) >= 12:
                    moved = float(np.median(np.linalg.norm(p1 - p0, axis=1))) / long_side
                    a = _rays(p1, fa, cx, cy)
                    b = _rays(p0, fa, cx, cy)
                    fit = rotation_ransac(a, b, threshold=2.0 / fa, iterations=48, seed=index)
                    if fit is not None and fit[1].sum() >= max(12, 0.4 * len(p0)):
                        rotvec = Rotation.from_matrix(fit[0]).as_rotvec()
                        ok = True
                    prev_pts = p1.reshape(-1, 1, 2).astype(np.float32)
                else:
                    prev_pts = None
            else:
                prev_pts = None
        flow.append(moved)
        rotvecs.append(rotvec)
        valid.append(ok)
        prev_gray = gray
        if on_frame and index % 30 == 0:
            on_frame(index)
    if size is None or len(times) < 2:
        raise VideoError("Видео пустое или повреждено")
    return FrameStats(
        times=np.asarray(times),
        sharpness=np.asarray(sharp),
        flow=np.asarray(flow),
        rel_rotvec=np.asarray(rotvecs),
        rot_valid=np.asarray(valid),
        size=size,
        focal_px=fa / min(1.0, ANALYSIS_SIDE / max(size)),
    )


def _rays(p: np.ndarray, f: float, cx: float, cy: float) -> np.ndarray:
    v = np.column_stack([(p[:, 0] - cx) / f, (p[:, 1] - cy) / f, np.ones(len(p))])
    return np.asarray(v / np.linalg.norm(v, axis=1, keepdims=True))


def extract(path: Path, indices: list[int], side: int = WORK_SIDE) -> list[np.ndarray]:
    """Second pass: the chosen frames, downscaled to `side` on the long edge."""
    wanted = set(indices)
    last = max(indices)
    kept: dict[int, np.ndarray] = {}
    for index, _, frame in _frames(path):
        if index in wanted:
            kept[index] = _resize_long(frame, side).copy()
        if index >= last:
            break
    missing = wanted - kept.keys()
    if missing:
        raise VideoError("Видео прочиталось не полностью — загрузите запись ещё раз")
    return [kept[i] for i in indices]


# --- sensor track <-> video ---------------------------------------------------------------


@dataclass
class Alignment:
    offset_s: float  # video time t corresponds to track time t + offset_s
    quarter_turns: int  # image rotated by k·90° about the optical axis against the track
    score: float  # cosine similarity of the angular velocities, 0..1

    def rotations(self, track: OrientationTrack, times: np.ndarray) -> np.ndarray:
        return np.asarray(track.at(times + self.offset_s) @ _quarter(self.quarter_turns))


def _quarter(k: int) -> np.ndarray:
    return np.asarray(Rotation.from_rotvec([0.0, 0.0, k * math.pi / 2]).as_matrix())


def align(track: OrientationTrack, stats: FrameStats) -> Alignment:
    """Finds the clock offset and image rotation that make visual and sensor rotations agree.

    Compares angular velocities in camera axes (visual: KLT between consecutive frames; sensors:
    the track at shifted times). A wrong clock offset turns 20°/s of rotation into degrees of
    error per keyframe; a frame rotated against the track would break every prior.
    """
    default = Alignment(0.0, 0, 0.0)
    n = len(stats.times)
    if not track.has_rotations or n < 20:
        return default
    t = stats.times
    dt = np.diff(t)
    vis = stats.rel_rotvec[1:]
    ok = stats.rot_valid[1:] & (dt > 0)
    vis_speed = np.linalg.norm(vis, axis=1) / np.where(dt > 0, dt, 1)
    ok &= vis_speed > math.radians(3)  # only frames that actually rotate say anything
    if ok.sum() < 15:
        return default

    def sensor_rel(offset: float) -> np.ndarray:
        r = track.at(t + offset)
        rel = np.einsum("nba,nbc->nac", r[:-1], r[1:])  # R_{i-1}^T R_i
        return np.asarray(Rotation.from_matrix(rel).as_rotvec())

    vis_ok = vis[ok]
    vis_norm = float(np.linalg.norm(vis_ok))

    def score(offset: float, k: int) -> float:
        sk = sensor_rel(offset)[ok] @ _quarter(k)  # rows ω^T Q = (Q^T ω)^T
        denom = vis_norm * float(np.linalg.norm(sk))
        return float(np.sum(vis_ok * sk) / denom) if denom > 0 else -1.0

    best, best_score = default, -1.0
    for offset in np.arange(-MAX_OFFSET_S, MAX_OFFSET_S + 1e-9, 0.02):
        sens = sensor_rel(float(offset))[ok]
        sens_norm = float(np.linalg.norm(sens))
        for k in range(4):
            denom = vis_norm * sens_norm
            s = float(np.sum(vis_ok * (sens @ _quarter(k))) / denom) if denom > 0 else -1.0
            if s > best_score:
                best, best_score = Alignment(float(offset), k, s), s
    for offset in np.arange(best.offset_s - 0.02, best.offset_s + 0.0201, 0.004):
        s = score(float(offset), best.quarter_turns)
        if s > best_score:
            best, best_score = Alignment(float(offset), best.quarter_turns, s), s
    if best_score < 0.5:
        log.info("video/sensor alignment unreliable (score %.2f), using raw track", best_score)
        return Alignment(0.0, 0, max(best_score, 0.0))
    return best


# --- keyframe selection ---------------------------------------------------------------------


def select_pano_keyframes(
    rotations: np.ndarray,
    sharpness: np.ndarray,
    step_deg: float = 9.0,
    max_frames: int = 90,
) -> list[int]:
    """Sharp frames about step_deg apart in orientation, skipping places already covered.

    Every window of frames around the next step contributes its sharpest frame; frames blurred
    by fast rotation lose to their neighbours. Revisited directions (turning back) are skipped.
    """
    n = len(rotations)
    step = step_deg
    for _ in range(12):
        selected = _pano_pass(rotations, sharpness, step)
        if len(selected) <= max_frames:
            return selected
        step *= 1.2
    return selected[:: math.ceil(len(selected) / max_frames)] if n else []


def _pano_pass(rotations: np.ndarray, sharpness: np.ndarray, step: float) -> list[int]:
    n = len(rotations)
    selected: list[int] = []
    sel_rots: list[np.ndarray] = []
    anchor = rotations[0]
    i = 0
    first = True
    while i < n:
        angles = rotation_angles(anchor, rotations[i:])
        if first:
            window = np.flatnonzero(np.cumprod(angles < 0.5 * step))
        else:
            start = np.flatnonzero(angles >= 0.75 * step)
            if not len(start):
                break
            s = int(start[0])
            inside = np.cumprod(angles[s:] <= 1.25 * step)
            window = s + np.flatnonzero(inside) if inside.any() else np.array([s])
        cand = i + window
        local = sharpness[cand]
        k = int(cand[int(np.argmax(local))])
        first = False
        if sel_rots and rotation_angles(rotations[k], np.stack(sel_rots)).min() < 0.6 * step:
            anchor = rotations[k]  # revisit: move on without a new keyframe
        else:
            selected.append(k)
            sel_rots.append(rotations[k])
            anchor = rotations[k]
        i = k + 1
    return selected


def select_scan_keyframes(
    flow: np.ndarray,
    sharpness: np.ndarray,
    target: float = 0.07,
    max_frames: int = 110,
    min_frames: int = 24,
) -> list[int]:
    """One sharp frame per `target` of accumulated image motion (fraction of the long side).

    Motion-based spacing keeps a steady overlap between neighbours whether the phone turns or
    walks, and a phone standing still contributes a single frame.
    """
    cum = np.cumsum(flow)
    total = float(cum[-1]) if len(cum) else 0.0
    if total <= 0:
        return []
    step = min(max(target, total / max_frames), total / min_frames)
    bins = np.floor(cum / step).astype(int)
    selected = []
    for b in np.unique(bins):
        members = np.flatnonzero(bins == b)
        selected.append(int(members[np.argmax(sharpness[members])]))
    if len(selected) > max_frames:
        keep = np.linspace(0, len(selected) - 1, max_frames).round().astype(int)
        selected = [selected[k] for k in keep]
    return selected


def local_blur_mask(sharpness: np.ndarray, indices: list[int], ratio: float = 0.35) -> np.ndarray:
    """True for chosen frames much blurrier than the frames around them."""
    out = np.zeros(len(indices), bool)
    n = len(sharpness)
    for k, i in enumerate(indices):
        lo, hi = max(0, i - 15), min(n, i + 16)
        out[k] = sharpness[i] < ratio * float(np.median(sharpness[lo:hi]))
    return out
