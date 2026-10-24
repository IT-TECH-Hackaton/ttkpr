"""Room geometry from a sparse reconstruction: floor outline, wall height and camera path.

Input: 3D points and camera poses in an arbitrary SfM frame (unknown scale, unknown up) and,
per camera, which points it saw.

1. Up: the phone's gravity if the video came with an orientation track, otherwise from the
   cameras (a phone held upright keeps its x axis horizontal, its y axis points down).
2. Floor: RANSAC plane among points below the cameras with a normal close to up; the lowest
   well-supported plane wins (table tops are planes too). Its normal then refines up.
3. Scale: the phone was held camera_height_m above the floor, which turns SfM units into metres.
4. Ceiling: the highest dense horizontal layer above the cameras -> wall height.
5. Plan: every ray camera -> observed point, projected on the floor, is free space. That carves
   the room even with white walls, as long as something on, near or above the wall was seen
   (skirting, sockets, the wall-ceiling edge). Door and window gaps in the walls (points 0.2-2.2 m
   above the floor) are bridged along the dominant directions and cut off what was seen through
   them. The free region around the camera path is the room; its contour is simplified and
   straightened to the dominant (Manhattan) directions.

Output frame: metres, origin at the first camera's foot on the floor, y along its initial heading
projected on the floor, x to the right of it (z up).
"""

import itertools
import math
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

CELL_M = 0.05
WALL_BAND_M = (0.2, 2.2)  # what stops a ray: furniture and walls, not the floor or ceiling
MAX_EXTENT_M = 60.0


class RoomError(ValueError):
    """The scan cannot give a room; the message is shown to the organizer."""


@dataclass
class SceneInput:
    points: np.ndarray  # (N, 3) SfM frame
    centers: np.ndarray  # (M, 3) camera centres in capture order
    rotations: np.ndarray  # (M, 3, 3) camera -> world (OpenCV camera axes)
    observations: list[np.ndarray] | None = None  # per camera: indices into points
    up_hint: np.ndarray | None = None  # world up from the phone's gravity, unit vector


@dataclass
class RoomResult:
    polygon: list[tuple[float, float]]  # counter-clockwise, first vertex not repeated
    height_m: float | None
    area_m2: float
    camera_path: list[tuple[float, float]]
    point_count: int
    registered_frames: int
    total_frames: int
    confidence: float

    def to_json(self) -> dict[str, Any]:
        return {
            "polygon": [[x, y] for x, y in self.polygon],
            "heightM": self.height_m,
            "areaM2": self.area_m2,
            "cameraPath": [[x, y] for x, y in self.camera_path],
            "pointCount": self.point_count,
            "quality": {
                "registeredFrames": self.registered_frames,
                "totalFrames": self.total_frames,
                "scaleSource": "camera_height",
                "confidence": self.confidence,
            },
        }


# --- up, floor, ceiling -----------------------------------------------------------------------


def up_from_cameras(rotations: np.ndarray) -> np.ndarray:
    xs, ys = rotations[:, :, 0], rotations[:, :, 1]
    down = ys.mean(axis=0)
    values, vectors = np.linalg.eigh(xs.T @ xs)
    if values[1] > 0.05 * values[2]:
        up = vectors[:, 0]
        return up if up @ down < 0 else -up
    return np.asarray(-down / max(float(np.linalg.norm(down)), 1e-9))


@dataclass
class Plane:
    normal: np.ndarray  # unit, pointing up (towards the cameras)
    offset: float  # normal · p = offset on the plane
    inliers: int


def _fit_plane(points: np.ndarray) -> tuple[np.ndarray, float]:
    centroid = points.mean(axis=0)
    _, _, vt = np.linalg.svd(points - centroid)
    normal = vt[2]
    return normal, float(normal @ centroid)


def _ransac_plane(
    points: np.ndarray, up: np.ndarray, tau: float, max_tilt_deg: float, rng: np.random.Generator
) -> Plane | None:
    n = len(points)
    if n < 3:
        return None
    score_pts = points if n <= 6000 else points[rng.choice(n, 6000, replace=False)]
    best: Plane | None = None
    cos_tilt = math.cos(math.radians(max_tilt_deg))
    for _ in range(10):  # 10 x 60 hypotheses
        idx = rng.integers(0, n, (60, 3))
        p0, p1, p2 = points[idx[:, 0]], points[idx[:, 1]], points[idx[:, 2]]
        normals = np.cross(p1 - p0, p2 - p0)
        norms = np.linalg.norm(normals, axis=1)
        ok = norms > 1e-12
        normals[ok] /= norms[ok, None]
        normals *= np.sign(normals @ up)[:, None]
        ok &= normals @ up > cos_tilt
        if not ok.any():
            continue
        normals, p0 = normals[ok], p0[ok]
        offsets = np.einsum("kc,kc->k", normals, p0)
        dist = np.abs(score_pts @ normals.T - offsets)
        counts = (dist < tau).sum(axis=0)
        k = int(np.argmax(counts))
        if best is None or counts[k] > best.inliers:
            best = Plane(normals[k], float(offsets[k]), int(counts[k]))
    if best is None:
        return None
    # Refine on all points: the normal by least squares on the inliers, the offset at the densest
    # layer. A mean would be pulled off the floor by skirting boards and things lying on it.
    normal, offset = best.normal, best.offset
    for _ in range(3):
        inl = np.abs(points @ normal - offset) < tau
        if inl.sum() < 3:
            return None
        normal, _ = _fit_plane(points[inl])
        if normal @ up < 0:
            normal = -normal
        offset = _densest_layer(points[inl] @ normal, tau)
    count = int((np.abs(points @ normal - offset) < tau).sum())
    return Plane(normal, offset, count)


def _densest_layer(heights: np.ndarray, tau: float) -> float:
    """Mode of heights (bins of tau/4), refined by the median around it."""
    step = tau / 4
    lo = float(heights.min())
    counts = np.bincount(np.floor((heights - lo) / step).astype(int))
    smooth = np.convolve(counts.astype(np.float64), [1, 2, 1], mode="same")
    peak = lo + (int(np.argmax(smooth)) + 0.5) * step
    layer = heights[np.abs(heights - peak) < tau / 2]
    return float(np.median(layer)) if len(layer) else peak


def fit_floor(points: np.ndarray, centers: np.ndarray, up: np.ndarray, seed: int = 0) -> Plane:
    """Lowest well-supported plane below the cameras, tilted at most 20° from up."""
    rng = np.random.default_rng(seed)
    heights = points @ up
    cam = float(np.median(centers @ up))
    low = float(np.percentile(heights, 1))
    if cam - low <= 0:
        raise RoomError("Не найден пол: точки сцены не лежат ниже камеры")
    below = points[heights < cam - 0.25 * (cam - low)]
    if len(below) < 30:
        raise RoomError("Не найден пол: снимайте так, чтобы в кадр попадал пол у стен")
    depth = cam - float(np.percentile(below @ up, 2))  # ~ camera height above the floor
    tau = 0.025 * depth  # ~4 cm at 1.5 m
    plane = _ransac_plane(below, up, tau, 20.0, rng)
    if plane is None or plane.inliers < max(25, 0.03 * len(below)):
        raise RoomError("Не найден пол: снимайте так, чтобы в кадр попадал пол у стен")
    # A big table or a sofa can out-vote the floor; prefer a lower plane with decent support.
    for _ in range(3):
        lower = below[below @ plane.normal < plane.offset - 3 * tau]
        if len(lower) < 25:
            break
        candidate = _ransac_plane(lower, plane.normal, tau, 10.0, rng)
        if candidate is None or candidate.inliers < max(25, 0.3 * plane.inliers):
            break
        plane = candidate
    return plane


def fit_ceiling(z: np.ndarray, camera_z: float) -> float | None:
    """Height of the highest dense horizontal layer above the cameras (metres), if any."""
    above = z[(z > max(1.9, camera_z + 0.3)) & (z < 8.0)]
    if len(above) < 20:
        return None
    bins = np.arange(float(above.min()), float(above.max()) + 0.04, 0.03)
    if len(bins) < 3:
        return float(np.median(above))
    hist, edges = np.histogram(above, bins=bins)
    smooth = np.convolve(hist, [1, 2, 1], mode="same") / 4
    significant = np.flatnonzero(smooth >= max(6.0, 0.25 * float(smooth.max())))
    if not len(significant):
        return None
    top = int(significant[-1])
    # walk up to the local maximum of that layer
    while top + 1 < len(smooth) and smooth[top + 1] >= smooth[top]:
        top += 1
    centre = (edges[top] + edges[top + 1]) / 2
    layer = above[np.abs(above - centre) < 0.06]
    if len(layer) < 8:
        return None
    height = float(np.median(layer))
    return height if 1.9 <= height <= 8.0 else None


# --- plan -------------------------------------------------------------------------------------


def dominant_angle(xy: np.ndarray) -> float:
    """Wall direction (radians, in [0, pi/2)) that makes the point histograms sharpest."""
    if len(xy) < 10:
        return 0.0
    pts = xy if len(xy) <= 20000 else xy[:: math.ceil(len(xy) / 20000)]

    def score(theta: float) -> float:
        c, s = math.cos(theta), math.sin(theta)
        u = pts[:, 0] * c + pts[:, 1] * s
        v = -pts[:, 0] * s + pts[:, 1] * c
        total = 0.0
        for coord in (u, v):
            hist = np.bincount(np.floor((coord - coord.min()) / CELL_M).astype(int))
            total += float(np.sum(hist.astype(np.float64) ** 2))
        return total

    coarse = np.radians(np.arange(0, 90, 1.0))
    best = float(coarse[int(np.argmax([score(t) for t in coarse]))])
    fine = best + np.radians(np.arange(-1.0, 1.01, 0.1))
    best = float(fine[int(np.argmax([score(t) for t in fine]))])
    return best % (math.pi / 2)


def _rot2(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def _carve(
    starts: np.ndarray,
    ends: np.ndarray,
    stop_short: np.ndarray,
    shape: tuple[int, int],
    max_samples: int = 1_000_000,
) -> np.ndarray:
    """Counts of rays (grid coordinates) crossing every cell; rays to obstacles stop 2 cells
    before their end point."""
    h, w = shape
    counts = np.zeros(h * w, np.int32)
    lengths = np.linalg.norm(ends - starts, axis=1)
    n_samples = np.ceil(lengths).astype(np.int64) + 1
    begin = 0
    while begin < len(starts):
        cum = np.cumsum(n_samples[begin:])
        stop = begin + max(1, int(np.searchsorted(cum, max_samples)))
        s, e, ns = starts[begin:stop], ends[begin:stop], n_samples[begin:stop]
        short = stop_short[begin:stop]
        ray = np.repeat(np.arange(len(s)), ns)
        offsets = np.concatenate([[0], np.cumsum(ns)[:-1]])
        k = np.arange(int(ns.sum())) - np.repeat(offsets, ns)
        last = ns[ray] - 1
        t = k / np.maximum(last, 1)
        keep = ~short[ray] | (k <= last - 2)
        x = s[ray, 0] + t * (e[ray, 0] - s[ray, 0])
        y = s[ray, 1] + t * (e[ray, 1] - s[ray, 1])
        ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
        keep &= (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
        counts += np.bincount(iy[keep] * w + ix[keep], minlength=h * w).astype(np.int32)
        begin = stop
    return counts.reshape(h, w)


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    padded = np.zeros((h + 2, w + 2), np.uint8)
    padded[1:-1, 1:-1] = mask.astype(np.uint8)
    flood = padded.copy()
    cv2.floodFill(flood, np.zeros((h + 4, w + 4), np.uint8), (0, 0), 2)
    return np.asarray(flood[1:-1, 1:-1] != 2)


def _component_with(mask: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    count, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)
    if count <= 1:
        return np.zeros_like(mask, bool)
    h, w = mask.shape
    sx = np.clip(seeds[:, 0].astype(int), 0, w - 1)
    sy = np.clip(seeds[:, 1].astype(int), 0, h - 1)
    hits = labels[sy, sx]
    hits = hits[hits > 0]
    if len(hits):
        label = int(np.bincount(hits.astype(np.int64)).argmax())
    else:  # cameras in a carved hole: take the biggest region
        label = int(np.bincount(labels[labels > 0].astype(np.int64)).argmax())
    return np.asarray(labels == label)


def _square(cells: int) -> np.ndarray:
    return np.ones((cells, cells), np.uint8)


def _occupancy(
    xy: np.ndarray, origin: np.ndarray, shape: tuple[int, int], cell: float
) -> np.ndarray:
    grid = np.zeros(shape, np.uint8)
    g = np.floor((xy - origin) / cell).astype(int)
    ok = (g[:, 0] >= 0) & (g[:, 0] < shape[1]) & (g[:, 1] >= 0) & (g[:, 1] < shape[0])
    grid[g[ok, 1], g[ok, 0]] = 1
    return grid


@dataclass
class Rays:
    """Plan view of what the cameras saw (aligned frame, metres): one ray per observation."""

    start: np.ndarray  # (n, 2) camera
    end: np.ndarray  # (n, 2) seen point
    obstacle: np.ndarray  # (n,) the point blocks the view (wall/furniture), not floor/ceiling


def free_space(
    rays: Rays, cams_xy: np.ndarray, origin: np.ndarray, shape: tuple[int, int], cell: float
) -> np.ndarray:
    """Cells crossed by rays, gaps between rays closed, the region around the cameras with its
    holes (furniture, occlusions) filled."""
    seeds = (cams_xy - origin) / cell
    free = _carve((rays.start - origin) / cell, (rays.end - origin) / cell, rays.obstacle, shape)
    closed = cv2.morphologyEx((free > 0).astype(np.uint8), cv2.MORPH_CLOSE, _square(5))
    return _fill_holes(_component_with(closed.astype(bool), seeds))


@dataclass
class WallEdge:
    axis: int  # 0: x = value (vertical in the plan), 1: y = value
    value: float
    lo: float  # extent along the other axis
    hi: float
    line: int  # index of the line in its list
    span: int  # index of the interval between crossing lines


def wall_edges(
    xs: list[float], ys: list[float], walls: np.ndarray, origin: np.ndarray, cell: float
) -> list[WallEdge]:
    """Pieces of wall lines (between crossing lines) mostly covered by wall points. A door or a
    window leaves most of such a piece covered, so it still counts as wall."""
    h, w = walls.shape
    along_x = cv2.dilate(walls.astype(np.uint8), np.ones((5, 3), np.uint8))  # for y = value
    along_y = cv2.dilate(walls.astype(np.uint8), np.ones((3, 5), np.uint8))  # for x = value
    edges: list[WallEdge] = []
    for axis, lines, cross, grid in ((0, xs, ys, along_y), (1, ys, xs, along_x)):
        for k, value in enumerate(lines):
            fixed = int((value - origin[axis]) / cell)
            if not 0 <= fixed < (w if axis == 0 else h):
                continue
            for s, (a, b) in enumerate(itertools.pairwise(cross)):
                i0 = max(0, int((a - origin[1 - axis]) / cell))
                i1 = min(h if axis == 0 else w, int((b - origin[1 - axis]) / cell))
                if i1 - i0 < 4:
                    continue
                strip = grid[i0:i1, fixed] if axis == 0 else grid[fixed, i0:i1]
                if float(strip.mean()) >= 0.45:
                    edges.append(WallEdge(axis, value, a, b, k, s))
    return edges


def truncate_rays(rays: Rays, edges: list[WallEdge]) -> Rays:
    """Cuts every ray where it crosses a wall piece before reaching its point: what was seen
    through a door or a window is not part of the room."""
    s, e = rays.start, rays.end
    d = e - s
    length = np.linalg.norm(d, axis=1)
    t_cut = np.ones(len(s))
    for edge in edges:
        a = edge.axis
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (edge.value - s[:, a]) / d[:, a]
        other = s[:, 1 - a] + t * d[:, 1 - a]
        hit = (
            np.isfinite(t)
            & (t * length > 0.05)
            & ((1 - t) * length > 0.08)  # a point on this wall is not cut off by it
            & (other >= edge.lo)
            & (other <= edge.hi)
        )
        t_cut = np.where(hit & (t < t_cut), t, t_cut)
    cut = t_cut < 1
    return Rays(s, s + d * t_cut[:, None], rays.obstacle | cut)


def wall_lines(values: np.ndarray, lo: float, hi: float, separation: float = 0.3) -> list[float]:
    """Positions along one axis where points pile up: walls seen edge-on in the plan.

    A door or a window does not break the line, which is what keeps the view through them out
    of the room. Peaks must stand out from the background (furniture, clutter)."""
    if len(values) < 10 or hi - lo < 2 * CELL_M:
        return []
    hist, edges = np.histogram(values, np.arange(lo, hi + CELL_M, CELL_M))
    smooth = np.convolve(hist.astype(np.float64), [1, 2, 3, 2, 1], mode="same") / 9
    if smooth.max() <= 0:
        return []
    floor_level = float(np.median(smooth[smooth > 0]))
    threshold = max(4.0, 3.0 * floor_level, 0.12 * float(smooth.max()))
    is_peak = (
        (smooth >= threshold) & (smooth >= np.roll(smooth, 1)) & (smooth >= np.roll(smooth, -1))
    )
    centres = (edges[:-1] + edges[1:]) / 2
    lines: list[float] = []
    for k in np.flatnonzero(is_peak)[np.argsort(-smooth[is_peak])]:
        c = float(centres[k])
        if all(abs(c - other) >= separation for other in lines):
            near = values[np.abs(values - c) < 1.5 * CELL_M]
            lines.append(float(near.mean()) if len(near) else c)
    return sorted(lines)


def _outline_lines(
    free: np.ndarray, origin: np.ndarray, cell: float
) -> tuple[list[float], list[float]]:
    """Long axis-aligned edges of the free region: walls nobody saw a point on still end it."""
    contours, _ = cv2.findContours(free.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    xs: list[float] = []
    ys: list[float] = []
    if not contours:
        return xs, ys
    contour = max(contours, key=cv2.contourArea)
    poly = (cv2.approxPolyDP(contour, 2.0, True).reshape(-1, 2) + 0.5) * cell + origin
    for a, b in zip(poly, np.roll(poly, -1, axis=0), strict=True):
        d = b - a
        length = float(np.hypot(*d))
        if length < 0.6:
            continue
        if abs(d[0]) < 0.08 * length:
            xs.append(float((a[0] + b[0]) / 2))
        elif abs(d[1]) < 0.08 * length:
            ys.append(float((a[1] + b[1]) / 2))
    return xs, ys


def _merge_lines(primary: list[float], extra: list[float], separation: float = 0.3) -> list[float]:
    lines = list(primary)
    for v in extra:
        if all(abs(v - other) >= separation for other in lines):
            lines.append(v)
    return sorted(lines)


def manhattan_outline(
    rays: Rays,
    wall_xy: np.ndarray,
    tall_xy: np.ndarray,
    origin: np.ndarray,
    shape: tuple[int, int],
    cell: float,
    cams_xy: np.ndarray,
    min_free: float = 0.6,
) -> tuple[Polygon, np.ndarray] | None:
    """Room as a union of cells of the wall-line arrangement that are mostly free space, with
    rays cut at the walls. wall_xy places the lines; tall_xy (points high up: upper wall, the
    wall-ceiling edge) confirms which pieces are walls, so a cabinet or a sofa front does not
    cut the room. Returns the outline and the free-space grid it was labelled on."""
    h, w = shape
    x_lo, y_lo = float(origin[0]), float(origin[1])
    x_hi, y_hi = x_lo + w * cell, y_lo + h * cell
    extra_x, extra_y = _outline_lines(free_space(rays, cams_xy, origin, shape, cell), origin, cell)
    xs = _merge_lines(wall_lines(wall_xy[:, 0], x_lo, x_hi), extra_x)
    ys = _merge_lines(wall_lines(wall_xy[:, 1], y_lo, y_hi), extra_y)
    if len(xs) < 2 or len(ys) < 2:
        return None
    xs = sorted({x_lo, *xs, x_hi})
    ys = sorted({y_lo, *ys, y_hi})
    walls = _occupancy(tall_xy if len(tall_xy) >= 30 else wall_xy, origin, shape, cell)
    edges = wall_edges(xs, ys, walls, origin, cell)
    free = free_space(truncate_rays(rays, edges), cams_xy, origin, shape, cell)
    # Where the operator walked is free too (behind the phone nobody films).
    path = np.round((cams_xy - origin) / cell).astype(np.int32).reshape(-1, 1, 2)
    walked = np.zeros(shape, np.uint8)
    cv2.polylines(walked, [path], False, 1, thickness=max(1, round(0.4 / cell)))
    free |= walked.astype(bool)

    col = np.clip(np.round((np.asarray(xs) - x_lo) / cell).astype(int), 0, w)
    row = np.clip(np.round((np.asarray(ys) - y_lo) / cell).astype(int), 0, h)
    integral = cv2.integral(free.astype(np.uint8))
    nx, ny = len(xs) - 1, len(ys) - 1
    fraction = np.zeros((ny, nx))
    for j in range(ny):
        for i in range(nx):
            r0, r1, c0, c1 = row[j], row[j + 1], col[i], col[i + 1]
            area = (r1 - r0) * (c1 - c0)
            if area > 0:
                filled = integral[r1, c1] - integral[r0, c1] - integral[r1, c0] + integral[r0, c0]
                fraction[j, i] = filled / area
    # Cells that are mostly free are room; partly free ones join through boundaries that are not
    # walls (lines from furniture or clutter split the room into cells, walls end it).
    blocked = {(e.axis, e.line, e.span) for e in edges}
    inside = fraction >= min_free
    queue = list(zip(*np.nonzero(inside), strict=True))
    while queue:
        j, i = queue.pop()
        for dj, di, key in (
            (0, 1, (0, i + 1, j)),
            (0, -1, (0, i, j)),
            (1, 0, (1, j + 1, i)),
            (-1, 0, (1, j, i)),
        ):
            nj, ni = j + dj, i + di
            if (
                0 <= nj < ny
                and 0 <= ni < nx
                and not inside[nj, ni]
                and key not in blocked
                and fraction[nj, ni] >= 0.25
            ):
                inside[nj, ni] = True
                queue.append((nj, ni))
    count, labels = cv2.connectedComponents(inside.astype(np.uint8), connectivity=4)
    if count <= 1:
        return None
    ci = np.clip(np.searchsorted(xs, cams_xy[:, 0]) - 1, 0, nx - 1)
    cj = np.clip(np.searchsorted(ys, cams_xy[:, 1]) - 1, 0, ny - 1)
    hits = labels[cj, ci]
    hits = hits[hits > 0]
    label = (
        int(np.bincount(hits.astype(np.int64)).argmax())
        if len(hits)
        else int(np.bincount(labels[labels > 0].astype(np.int64)).argmax())
    )
    cells = [
        box(xs[i], ys[j], xs[i + 1], ys[j + 1])
        for j, i in zip(*np.nonzero(labels == label), strict=True)
    ]
    union = unary_union(cells)
    if union.geom_type == "MultiPolygon":
        union = max(union.geoms, key=lambda g: g.area)
    if union.geom_type != "Polygon" or union.is_empty:
        return None
    return Polygon(union.exterior).simplify(0.01), free


def contour_outline(
    free: np.ndarray, origin: np.ndarray, cell: float, cams_xy: np.ndarray
) -> Polygon:
    """Fallback for rooms without clear wall lines: the free region's contour, thin leaks
    opened away, edges snapped to the axes where close."""
    seeds = (cams_xy - origin) / cell
    room = cv2.morphologyEx(free.astype(np.uint8), cv2.MORPH_OPEN, _square(9)).astype(bool)
    room = _fill_holes(_component_with(room, seeds))
    contours, _ = cv2.findContours(room.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise RoomError("Не удалось выделить комнату: обойдите её целиком, снимая стены")
    simple = cv2.approxPolyDP(max(contours, key=cv2.contourArea), 2.0, True).reshape(-1, 2)
    if len(simple) < 3:
        raise RoomError("Не удалось выделить комнату: контур вырожден")
    # The contour runs through the centres of the outermost free cells; add half a cell.
    simple_m = (simple.astype(np.float64) + 0.5) * cell + origin
    rough = Polygon(simple_m)
    rough = rough if rough.is_valid else rough.buffer(0)
    candidate = Polygon(straighten(simple_m))
    if not candidate.is_valid or candidate.area < 0.7 * rough.area:
        candidate = rough
    grown = candidate.buffer(cell / 2, join_style="mitre")
    if grown.geom_type == "MultiPolygon":
        grown = max(grown.geoms, key=lambda g: g.area)
    return grown if grown.geom_type == "Polygon" and not grown.is_empty else candidate


def straighten(poly: np.ndarray, tol_deg: float = 12.0, min_edge: float = 0.15) -> np.ndarray:
    """Snaps edges of a polygon (aligned frame) to the x/y axes when within tol_deg, merges
    collinear runs, intersects neighbouring lines for the corners and drops tiny edges."""
    pts = np.asarray(poly, dtype=np.float64)
    n = len(pts)
    if n < 3:
        return pts
    nxt = np.roll(pts, -1, axis=0)
    d = nxt - pts
    lengths = np.linalg.norm(d, axis=1)
    angles = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 180
    kinds = np.where(
        (angles < tol_deg) | (angles > 180 - tol_deg),
        "h",
        np.where(np.abs(angles - 90) < tol_deg, "v", "d"),
    )
    # Start at a change of kind so no run wraps around the end.
    start = next((i for i in range(n) if kinds[i] != kinds[i - 1]), 0)
    order = [(start + i) % n for i in range(n)]

    # Lines as (kind, value | (point, direction), weight).
    lines: list[tuple[str, np.ndarray, np.ndarray, float]] = []
    for i in order:
        kind = str(kinds[i])
        mid = (pts[i] + nxt[i]) / 2
        if lines and kind in "hv" and lines[-1][0] == kind:
            k, p, direction, wsum = lines[-1]
            merged = (p * wsum + mid * lengths[i]) / (wsum + lengths[i])
            lines[-1] = (k, merged, direction, wsum + lengths[i])
            continue
        direction = (
            np.array([1.0, 0.0])
            if kind == "h"
            else np.array([0.0, 1.0])
            if kind == "v"
            else d[i] / max(lengths[i], 1e-12)
        )
        lines.append((kind, mid, direction, float(lengths[i])))

    def corners(ls: list[tuple[str, np.ndarray, np.ndarray, float]]) -> np.ndarray:
        out = []
        for a in range(len(ls)):
            _, p1, d1, _ = ls[a - 1]
            _, p2, d2, _ = ls[a]
            cross = d1[0] * d2[1] - d1[1] * d2[0]
            if abs(cross) < 1e-9:
                out.append((p1 + p2) / 2)
                continue
            t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross
            out.append(p1 + t * d1)
        return np.asarray(out)

    for _ in range(2 * n):
        if len(lines) < 3:
            return pts
        verts = corners(lines)
        edge = np.linalg.norm(np.roll(verts, -1, axis=0) - verts, axis=1)
        # edge a runs from corner a (lines a-1/a) to corner a+1 (lines a/a+1): it is line a
        short = int(np.argmin(edge))
        if edge[short] >= min_edge:
            return verts
        del lines[short]
        # neighbours of the same axis kind become one line
        if len(lines) >= 2:
            a = short % len(lines)
            b = a - 1
            ka, pa, da, wa = lines[a]
            kb, pb, _, wb = lines[b]
            if ka == kb and ka in "hv":
                lines[b] = (kb, (pa * wa + pb * wb) / (wa + wb), da, wa + wb)
                del lines[a]
    return corners(lines)


def _perimeter_support(
    poly: np.ndarray, walls: np.ndarray, origin: np.ndarray, cell: float
) -> float:
    """Share of the outline that has wall points within ~15 cm (vs. inferred from free space)."""
    near = cv2.dilate(walls.astype(np.uint8), _square(7)).astype(bool)
    h, w = walls.shape
    total = hit = 0
    for a, b in zip(poly, np.roll(poly, -1, axis=0), strict=True):
        steps = max(2, int(np.linalg.norm(b - a) / 0.1))
        for t in np.linspace(0, 1, steps, endpoint=False):
            gx, gy = ((a + t * (b - a)) - origin) / cell
            ix, iy = int(gx), int(gy)
            total += 1
            if 0 <= ix < w and 0 <= iy < h and near[iy, ix]:
                hit += 1
    return hit / total if total else 0.0


# --- entry point --------------------------------------------------------------------------------


def reconstruct_room(
    scene: SceneInput, camera_height_m: float = 1.5, total_frames: int | None = None
) -> RoomResult:
    points = np.asarray(scene.points, dtype=np.float64)
    centers = np.asarray(scene.centers, dtype=np.float64)
    rotations = np.asarray(scene.rotations, dtype=np.float64)
    if len(centers) < 3 or len(points) < 100:
        raise RoomError("Слишком мало данных: обойдите комнату медленнее, снимая стены и пол")
    up = scene.up_hint if scene.up_hint is not None else up_from_cameras(rotations)
    up = np.asarray(up, dtype=np.float64) / np.linalg.norm(up)

    floor = fit_floor(points, centers, up)
    n, d = floor.normal, floor.offset
    cam_heights = centers @ n - d
    median_h = float(np.median(cam_heights))
    if median_h <= 0:
        raise RoomError("Не найден пол: камера оказалась ниже найденной плоскости")
    scale = camera_height_m / median_h

    # Local frame: first camera's foot, its heading on the floor as y, x to the right.
    origin3 = centers[0] - cam_heights[0] * n
    fwd = rotations[0][:, 2] - (rotations[0][:, 2] @ n) * n
    if np.linalg.norm(fwd) < 0.2:  # looking straight down or up: use the image top instead
        fwd = -rotations[0][:, 1] - (-rotations[0][:, 1] @ n) * n
    ey = fwd / np.linalg.norm(fwd)
    ex = np.cross(ey, n)

    def local(p: np.ndarray) -> np.ndarray:
        rel = p - origin3
        return np.column_stack([rel @ ex, rel @ ey, p @ n - d]) * scale

    pts = local(points)
    cams = local(centers)
    camera_z = float(np.median(cams[:, 2]))
    ceiling = fit_ceiling(pts[:, 2], camera_z)

    # Points that can belong to the room: between the floor and the ceiling (or 4 m), not far.
    top = (ceiling + 0.3) if ceiling else 4.0
    lo_xy, hi_xy = cams[:, :2].min(axis=0) - 25, cams[:, :2].max(axis=0) + 25
    usable = (
        (pts[:, 2] > -0.3)
        & (pts[:, 2] < top)
        & np.all(pts[:, :2] > lo_xy, axis=1)
        & np.all(pts[:, :2] < hi_xy, axis=1)
    )
    wall_top = min(WALL_BAND_M[1], (ceiling - 0.15) if ceiling else WALL_BAND_M[1])
    band = usable & (pts[:, 2] >= WALL_BAND_M[0]) & (pts[:, 2] <= wall_top)
    # Wall evidence for the plan: everything but the floor and ceiling surfaces themselves
    # (skirting and the wall-ceiling edge are the most reliable points on white walls).
    room_top = ceiling if ceiling else float(np.percentile(pts[usable, 2], 99))
    walls = usable & (pts[:, 2] > 0.04) & (pts[:, 2] < room_top - 0.04)
    tall = usable & (pts[:, 2] >= min(1.9, 0.7 * room_top)) & (pts[:, 2] < room_top + 0.05)
    theta = dominant_angle(pts[walls, :2] if walls.sum() >= 30 else pts[usable, :2])
    to_aligned = _rot2(-theta)
    aligned = pts[:, :2] @ to_aligned.T
    cams_aligned = cams[:, :2] @ to_aligned.T

    # Rays: per camera the points it saw; without visibility, the three nearest cameras.
    if scene.observations is not None:
        obs_cam = np.concatenate(
            [np.full(len(o), k) for k, o in enumerate(scene.observations)]
        ).astype(int)
        obs_pt = np.concatenate([np.asarray(o, dtype=int) for o in scene.observations])
    else:
        dists = np.linalg.norm(pts[:, None, :2] - cams[None, :, :2], axis=2)
        nearest = np.argsort(dists, axis=1)[:, :3]
        obs_pt = np.repeat(np.arange(len(pts)), nearest.shape[1])
        obs_cam = nearest.ravel()
    sel = usable[obs_pt]
    obs_cam, obs_pt = obs_cam[sel], obs_pt[sel]
    if len(obs_pt) < 50:
        raise RoomError("Слишком мало точек внутри комнаты: снимайте медленнее и ближе к стенам")
    obstacle = band[obs_pt]

    used_xy = np.vstack([aligned[usable], cams_aligned])
    lo = np.percentile(used_xy, 0.5, axis=0) - 1.0
    hi = np.percentile(used_xy, 99.5, axis=0) + 1.0
    lo = np.minimum(lo, cams_aligned.min(axis=0) - 1.0)
    hi = np.maximum(hi, cams_aligned.max(axis=0) + 1.0)
    extent = np.minimum(hi - lo, MAX_EXTENT_M)
    cell = max(CELL_M, float(extent.max()) / 1200)
    shape = (math.ceil(extent[1] / cell) + 1, math.ceil(extent[0] / cell) + 1)
    rays = Rays(cams_aligned[obs_cam], aligned[obs_pt], obstacle)
    found = manhattan_outline(rays, aligned[walls], aligned[tall], lo, shape, cell, cams_aligned)
    if found is not None and found[0].area >= 1.0:
        outline, free = found
    else:  # no clear wall lines (round or very cluttered room): the free region itself
        free = free_space(rays, cams_aligned, lo, shape, cell)
        if float(free.sum()) * cell * cell < 1.0:
            raise RoomError("Не удалось выделить комнату: обойдите её целиком, снимая стены")
        outline = contour_outline(free, lo, cell, cams_aligned)
    straight = np.asarray(outline.exterior.coords)[:-1]
    support = _perimeter_support(straight, _occupancy(aligned[walls], lo, shape, cell), lo, cell)

    back = _rot2(theta)
    polygon = orient(Polygon(straight @ back.T), sign=1.0)
    coords = [(round(x, 3), round(y, 3)) for x, y in list(polygon.exterior.coords)[:-1]]

    registered = len(centers)
    total = total_frames or registered
    spread = float(np.subtract(*np.percentile(cam_heights, [75, 25])) / median_h)
    confidence = (
        math.sqrt(min(1.0, registered / max(total, 1)))
        * (0.35 + 0.65 * support)
        * (0.5 + 0.5 * min(1.0, floor.inliers / 150))
        * max(0.3, 1.0 - spread)
    )
    path = cams[:, :2]
    if len(path) > 300:
        path = path[np.linspace(0, len(path) - 1, 300).round().astype(int)]
    return RoomResult(
        polygon=coords,
        height_m=round(ceiling, 2) if ceiling else None,
        area_m2=round(float(polygon.area), 2),
        camera_path=[(round(float(x), 3), round(float(y), 3)) for x, y in path],
        point_count=int(usable.sum()),
        registered_frames=registered,
        total_frames=total,
        confidence=round(float(np.clip(confidence, 0.0, 1.0)), 2),
    )
