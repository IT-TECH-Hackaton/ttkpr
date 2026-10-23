"""Celery tasks. Names are the contract with apps/api (it enqueues by name via send_task)."""

from worker.celery_app import app


@app.task(name="worker.tasks.stitch_panorama")
def stitch_panorama(pano_id: str) -> None:
    """Frames + sensor quaternions -> equirect 8192x4096 -> tile_panorama.

    Pipeline (docs/ARCHITECTURE.md, «Склейка»): sensor-initialised rotations, overlap-limited
    pair matching, bundle adjustment with sensor priors, gravity-levelled horizon, exposure
    compensation, graph-cut seams, multi-band blending, nadir fill.
    """
    raise NotImplementedError("stitching pipeline is owned by the panorama-pipeline agent")


@app.task(name="worker.tasks.tile_panorama")
def tile_panorama(pano_id: str) -> None:
    """Download the equirect from S3, run worker.tiles.make_tiles, upload, mark the pano ready."""
    raise NotImplementedError("S3 wiring pending; tiling itself lives in worker.tiles")


@app.task(name="worker.tasks.build_map_version")
def build_map_version(map_id: str, version_id: str) -> None:
    """Validate draft -> nav graph -> pano visibility -> search index -> bundle.json -> manifest."""
    raise NotImplementedError("map build is owned by the geo-routing agent")
