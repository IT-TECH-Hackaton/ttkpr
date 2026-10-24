"""Structure from motion for room scans: COLMAP 4 through pycolmap, CPU only.

pycolmap is imported lazily: the worker starts and stitches panoramas without it, and a scan then
fails with a clear message instead of the whole worker failing to boot.

Video keyframes are matched sequentially (each with its next ~8 and a few further ones), plus loop
candidates: the end of the walk against its start, and pairs that look alike (tiny thumbnails) or
look the same way (phone orientation track). No vocabulary tree is needed.
"""

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

log = logging.getLogger(__name__)

Progress = Callable[[float], None]

MAX_FEATURES = 4096
SEQUENTIAL_OVERLAP = 8


class SfmUnavailable(RuntimeError):
    pass


class SfmFailed(RuntimeError):
    pass


@dataclass
class SfmResult:
    points: np.ndarray  # (N, 3)
    centers: np.ndarray  # (M, 3) registered cameras, in keyframe order
    rotations: np.ndarray  # (M, 3, 3) camera -> world (OpenCV camera axes, as COLMAP)
    frame_ids: list[int]  # keyframe number of each registered camera
    observations: list[np.ndarray]  # per registered camera: indices into points
    focal_px: float
    reprojection_error: float


def loop_pairs(
    images: list[np.ndarray],
    rotations: np.ndarray | None = None,
    overlap: int = SEQUENTIAL_OVERLAP,
    per_frame: int = 2,
) -> list[tuple[int, int]]:
    """Non-sequential pairs worth matching: the walk's end against its start, similar
    thumbnails, and (with sensors) frames looking the same way."""
    n = len(images)
    pairs: set[tuple[int, int]] = set()
    block = min(8, n // 4)
    for a in range(block):
        for b in range(n - block, n):
            if b - a > overlap:
                pairs.add((a, b))
    thumbs = np.stack(
        [
            cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (24, 16), interpolation=cv2.INTER_AREA)
            .astype(np.float64)
            .ravel()
            for im in images
        ]
    )
    thumbs -= thumbs.mean(axis=1, keepdims=True)
    thumbs /= np.maximum(np.linalg.norm(thumbs, axis=1, keepdims=True), 1e-9)
    sim = thumbs @ thumbs.T
    if rotations is not None:
        fwd = rotations[:, :, 2]
        sim = sim + 0.5 * (fwd @ fwd.T > math.cos(math.radians(25)))
    idx = np.arange(n)
    for a in range(n):
        far = np.abs(idx - a) > overlap
        cand = idx[far]
        if not len(cand):
            continue
        for b in cand[np.argsort(-sim[a, far])[:per_frame]]:
            pairs.add((min(a, int(b)), max(a, int(b))))
    return sorted(pairs)


def _pycolmap() -> Any:
    try:
        import pycolmap
    except ImportError as exc:  # pragma: no cover - depends on the image
        raise SfmUnavailable(
            "На сервере не установлен pycolmap — обработка сканов комнат недоступна"
        ) from exc
    return pycolmap


def write_images(images: list[np.ndarray], workdir: Path) -> list[str]:
    """Keyframes as JPEG files for COLMAP (named by keyframe number), so the arrays can go."""
    image_dir = workdir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    names = [f"{k:04d}.jpg" for k in range(len(images))]
    for name, image in zip(names, images, strict=True):
        cv2.imwrite(str(image_dir / name), image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return names


def run_sfm(
    workdir: Path,
    names: list[str],
    size: tuple[int, int],
    focal_px: float | None = None,
    extra_pairs: list[tuple[int, int]] | None = None,
    threads: int = 2,
    max_runtime_s: int = 720,
    progress: Progress | None = None,
) -> SfmResult:
    """workdir/images/<names> (see write_images) -> the largest COLMAP model. size = (w, h)."""
    pycolmap = _pycolmap()
    image_dir = workdir / "images"
    w, h = size
    database = workdir / "database.db"
    cpu = pycolmap.Device.cpu

    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "SIMPLE_RADIAL"
    f = focal_px or 0.75 * max(w, h)
    reader.camera_params = f"{f:.3f},{w / 2:.3f},{h / 2:.3f},0"
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = threads
    extraction.use_gpu = False
    extraction.max_image_size = max(w, h)
    extraction.sift.max_num_features = MAX_FEATURES
    pycolmap.extract_features(
        database,
        image_dir,
        image_names=names,
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader,
        extraction_options=extraction,
        device=cpu,
    )
    if progress:
        progress(0.3)

    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = threads
    matching.use_gpu = False
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = SEQUENTIAL_OVERLAP
    pairing.quadratic_overlap = True
    pairing.loop_detection = False
    pycolmap.match_sequential(
        database, matching_options=matching, pairing_options=pairing, device=cpu
    )
    if extra_pairs:
        match_list = workdir / "loop_pairs.txt"
        match_list.write_text(
            "\n".join(f"{names[a]} {names[b]}" for a, b in extra_pairs) + "\n", encoding="utf-8"
        )
        imported = pycolmap.ImportedPairingOptions()
        imported.match_list_path = str(match_list)
        pycolmap.match_image_pairs(
            database, matching_options=matching, pairing_options=imported, device=cpu
        )
    if progress:
        progress(0.6)

    options = pycolmap.IncrementalPipelineOptions()
    options.num_threads = threads
    options.max_runtime_seconds = max_runtime_s
    options.min_model_size = 5
    options.extract_colors = False
    out_dir = workdir / "sparse"
    out_dir.mkdir(exist_ok=True)
    models = pycolmap.incremental_mapping(database, image_dir, out_dir, options=options)
    if not models:
        raise SfmFailed("Не удалось восстановить сцену по видео: мало общих деталей между кадрами")
    rec = max(models.values(), key=lambda r: r.num_reg_images())
    if progress:
        progress(0.95)
    return _result(rec)


def _result(rec: Any) -> SfmResult:
    good: dict[int, int] = {}
    xyz: list[Any] = []
    for pid, point in rec.points3D.items():
        if point.track.length() >= 3 and point.error <= 2.0:
            good[pid] = len(xyz)
            xyz.append(np.asarray(point.xyz, dtype=np.float64))
    registered = sorted((im for im in rec.images.values() if im.has_pose), key=lambda im: im.name)
    centers, rotations, frame_ids, observations = [], [], [], []
    for im in registered:
        r_cw = np.asarray(im.cam_from_world().rotation.matrix())
        centers.append(np.asarray(im.projection_center()).ravel())
        rotations.append(r_cw.T)
        frame_ids.append(int(Path(im.name).stem))
        observations.append(
            np.asarray(
                [good[p.point3D_id] for p in im.get_observation_points2D() if p.point3D_id in good],
                dtype=int,
            )
        )
    camera = next(iter(rec.cameras.values()))
    return SfmResult(
        points=np.asarray(xyz).reshape(-1, 3),
        centers=np.asarray(centers).reshape(-1, 3),
        rotations=np.asarray(rotations).reshape(-1, 3, 3),
        frame_ids=frame_ids,
        observations=observations,
        focal_px=float(camera.mean_focal_length()),
        reprojection_error=float(rec.compute_mean_reprojection_error()),
    )
