"""Local ENU frame and plan <-> panorama projections.

Must stay identical to packages/map-core/src/geo.ts; both are checked against
fixtures/geo-vectors.json. Conventions are documented in docs/CONVENTIONS.md.
"""

import math

from map_schema.models import LonLat

EARTH_RADIUS_M = 6378137.0

XY = tuple[float, float]


def to_local(anchor: LonLat, point: LonLat) -> XY:
    """Lon/lat -> meters east/north of the anchor (local tangent plane, fine for < 10 km)."""
    lon0, lat0 = anchor
    lon, lat = point
    x = math.radians(lon - lon0) * EARTH_RADIUS_M * math.cos(math.radians(lat0))
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


def from_local(anchor: LonLat, xy: XY) -> LonLat:
    lon0, lat0 = anchor
    x, y = xy
    lon = lon0 + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(lat0))))
    lat = lat0 + math.degrees(y / EARTH_RADIUS_M)
    return lon, lat


def normalize_deg(angle: float) -> float:
    """Wrap to (-180, 180]."""
    a = math.fmod(angle, 360.0)
    if a <= -180.0:
        a += 360.0
    elif a > 180.0:
        a -= 360.0
    return a


def bearing_deg(origin: XY, target: XY) -> float:
    """Azimuth clockwise from north, [0, 360)."""
    dx = target[0] - origin[0]
    dy = target[1] - origin[1]
    return math.degrees(math.atan2(dx, dy)) % 360.0


def project_to_pano(
    pano_xy: XY,
    heading_deg: float,
    camera_height_m: float,
    target_xy: XY,
    target_height_m: float,
) -> tuple[float, float]:
    """Point on the plan -> (yaw, pitch) in degrees inside the panorama."""
    dist = math.hypot(target_xy[0] - pano_xy[0], target_xy[1] - pano_xy[1])
    yaw = normalize_deg(bearing_deg(pano_xy, target_xy) - heading_deg)
    pitch = math.degrees(math.atan2(target_height_m - camera_height_m, dist))
    return yaw, pitch


def floor_point_from_pano(
    pano_xy: XY,
    heading_deg: float,
    camera_height_m: float,
    yaw_deg: float,
    pitch_deg: float,
) -> XY | None:
    """Tap on the floor inside the panorama -> point on the plan. None if not looking down."""
    if pitch_deg >= 0:
        return None
    dist = camera_height_m / math.tan(math.radians(-pitch_deg))
    azimuth = math.radians(heading_deg + yaw_deg)
    return pano_xy[0] + dist * math.sin(azimuth), pano_xy[1] + dist * math.cos(azimuth)
