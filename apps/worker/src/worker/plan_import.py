"""Building plan (image or multi-page PDF) -> rooms, doors, windows, stairs, lifts and floors.

Classic computer vision, no trained model, so it works on any style of plan that draws walls as
the thickest lines:

1. Each page is rendered or shrunk to ~2000 px and binarised; text found by OCR is erased.
2. Walls are the strokes that survive an opening by about half the wall thickness, so furniture,
   dimension lines and hatching (thinner) drop out.
3. Door gaps are closed with a horizontal and a vertical closing; only thin fills count (a gap in a
   wall), so a corridor between two parallel walls is never filled. Each fill is an opening: a door
   between two rooms, an entrance or a window (thin lines inside the gap) on the outer wall.
4. Rooms are the enclosed free areas; they grow to the middle of their walls so neighbours touch,
   and their outlines are simplified and squared.
5. Stairs are rooms crossed by many evenly spaced parallel lines (the steps), lifts are small rooms
   with a cross; OCR words inside a room give its name and category ("Лестница", "WC", "Зал").
6. The scale comes from the doors (a door is ~0.9 m), the floors from the pages (or "2 этаж" on
   the page), and stairs or lifts in the same place on neighbouring floors are linked.

Coordinates in the result are fractions of the page image (x right, y down), like the studio's
underlays. The result is a draft for the organizer to check, not a finished plan.
"""

import csv
import io
import logging
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pyvips

log = logging.getLogger(__name__)

WORK_SIDE = 2000
MIN_SIDE = 1200
MAX_PAGES = 12
MAX_SOURCE_PIXELS = 150_000_000
DOOR_WIDTH_M = 0.9

Mask = np.ndarray  # uint8 0/255
Point = tuple[float, float]


class PlanImportError(Exception):
    """A plan that cannot be read; the message is shown to the organizer."""


@dataclass
class Word:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.w // 2, self.y + self.h // 2


@dataclass
class Room:
    ring: list[Point]  # pixels, closed
    area: float  # pixels
    center: Point
    bbox: tuple[int, int, int, int]  # x, y, w, h
    label: int = 0  # connected component of the free area
    name: str | None = None
    category: str = "room"
    words: list[str] = field(default_factory=list)


@dataclass
class OpeningCut:
    a: Point
    b: Point
    category: str  # door | entrance | window
    width_px: float
    rooms: tuple[int, ...] = ()


@dataclass
class PageResult:
    width: int
    height: int
    rooms: list[Room]
    openings: list[OpeningCut]
    wall_px: float
    floor: int | None = None
    text: str = ""

    def door_widths(self) -> list[float]:
        return [o.width_px for o in self.openings if o.category == "door"]


# --- input ----------------------------------------------------------------------------------


def _fit(gray: np.ndarray) -> np.ndarray:
    side = max(gray.shape)
    if side > WORK_SIDE:
        scale = WORK_SIDE / side
        return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    if side < MIN_SIDE:
        scale = MIN_SIDE / side
        return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return gray


def load_pages(path: Path) -> list[np.ndarray]:
    """Grey pages (uint8, white paper) at the working size."""
    with open(path, "rb") as fh:
        head = fh.read(8)
    if head.startswith(b"%PDF-"):
        return _pdf_pages(path)
    try:
        header = pyvips.Image.new_from_file(str(path))
    except pyvips.Error as exc:
        raise PlanImportError("Не удалось открыть картинку плана") from exc
    if header.width * header.height > MAX_SOURCE_PIXELS:
        raise PlanImportError("Картинка слишком большая: уменьшите её до 12 000 px по стороне")
    image = pyvips.Image.thumbnail(str(path), WORK_SIDE, size="down").autorot()
    if image.hasalpha():
        image = image.flatten(background=[255, 255, 255])
    image = image.colourspace("b-w")
    if image.bands > 1:
        image = image.extract_band(0)
    gray = np.ndarray(
        buffer=image.write_to_memory(), dtype=np.uint8, shape=(image.height, image.width)
    )
    return [_fit(gray.copy())]


def _pdf_pages(path: Path) -> list[np.ndarray]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as exc:
        raise PlanImportError("Не удалось открыть PDF: файл повреждён или защищён паролем") from exc
    try:
        if len(pdf) == 0:
            raise PlanImportError("В PDF нет страниц")
        pages = []
        for index in range(min(len(pdf), MAX_PAGES)):
            page = pdf[index]
            w_pt, h_pt = page.get_size()
            scale = min(8.0, WORK_SIDE / max(w_pt, h_pt, 1.0))
            bitmap = page.render(scale=scale, grayscale=True)
            array = np.asarray(bitmap.to_numpy())
            gray = array if array.ndim == 2 else cv2.cvtColor(array[..., :3], cv2.COLOR_RGB2GRAY)
            pages.append(_fit(np.ascontiguousarray(gray)))
        return pages
    finally:
        pdf.close()


# --- OCR -------------------------------------------------------------------------------------


class Ocr:
    """Tesseract through its command line (TSV output); absent binary -> no OCR."""

    def __init__(self) -> None:
        self.binary = shutil.which("tesseract")
        self.langs = ""
        if self.binary:
            try:
                out = subprocess.run(
                    [self.binary, "--list-langs"], capture_output=True, text=True, timeout=20
                ).stdout
                have = set(out.split())
                self.langs = "+".join(lang for lang in ("rus", "eng") if lang in have)
            except (OSError, subprocess.SubprocessError):
                self.binary = None

    @property
    def available(self) -> bool:
        return bool(self.binary and self.langs)

    def words(self, gray: np.ndarray) -> list[Word]:
        if not self.available or self.binary is None:
            return []
        with tempfile.TemporaryDirectory(prefix="ocr-") as tmp:
            image = Path(tmp) / "page.png"
            cv2.imwrite(str(image), gray)
            try:
                tsv = subprocess.run(
                    [self.binary, str(image), "stdout", "-l", self.langs, "--psm", "11", "tsv"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=180,
                ).stdout
            except (OSError, subprocess.SubprocessError):
                log.warning("tesseract failed", exc_info=True)
                return []
        words = []
        for row in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
            text = (row.get("text") or "").strip()
            try:
                conf = float(row.get("conf") or -1)
                box = [int(row[k]) for k in ("left", "top", "width", "height")]
            except (KeyError, ValueError):
                continue
            if row.get("level") == "5" and text and conf >= 55:
                words.append(Word(text, conf, *box))
        return words


# --- walls, openings, rooms ------------------------------------------------------------------


def binarize(gray: np.ndarray, mode: str = "otsu") -> Mask:
    """Ink, not paper. otsu: one global threshold; strict: never lighter than mid-grey, so pale
    colour fills of rooms stay paper; local: also faint thin lines next to heavy black walls
    (old scans), found against the local background."""
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    otsu, dark = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    if mode == "strict" and otsu > 160:
        _, dark = cv2.threshold(blur, 160, 255, cv2.THRESH_BINARY_INV)
    elif mode == "local":
        local = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 18
        )
        dark = cv2.bitwise_or(dark, local)
    return dark


def erase_words(dark: Mask, words: Sequence[Word], side: int) -> Mask:
    out = dark.copy()
    for w in words:
        if w.h < side * 0.05 and w.w < side * 0.4:
            cv2.rectangle(out, (w.x - 1, w.y - 1), (w.x + w.w + 1, w.y + w.h + 1), 0, -1)
    return out


def wall_thickness(dark: Mask) -> float:
    """Typical thickness of the thickest strokes (the walls), px."""
    dist = cv2.distanceTransform(dark, cv2.DIST_L2, 3)
    ridge = (dist >= 1) & (dist >= cv2.dilate(dist, np.ones((3, 3), np.uint8)))
    values = dist[ridge]
    if values.size == 0:
        return 2.0
    return float(max(2.0, 2 * np.percentile(values, 90)))


def extract_walls(dark: Mask, k: int) -> Mask:
    """Strokes at least k px thick (k < 2: all of them), without specks and glyphs."""
    side = max(dark.shape)
    walls = dark
    if k >= 2:
        walls = cv2.morphologyEx(
            dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        )
    thickness = max(2, k)
    # Walls are long.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(walls, connectivity=8)
    keep = np.zeros(count, np.uint8)
    min_extent = side * 0.012
    for i in range(1, count):
        w, h, area = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, 4]
        if max(w, h) >= min_extent and area >= max(20, thickness * thickness):
            keep[i] = 255
    return np.asarray(keep[labels], dtype=np.uint8)


@dataclass
class Gap:
    x: int
    y: int
    w: int
    h: int
    horizontal: bool  # the gap runs along a horizontal wall

    @property
    def length(self) -> int:
        return self.w if self.horizontal else self.h

    @property
    def segment(self) -> tuple[Point, Point]:
        if self.horizontal:
            cy = self.y + self.h / 2
            return (float(self.x), cy), (float(self.x + self.w), cy)
        cx = self.x + self.w / 2
        return (cx, float(self.y)), (cx, float(self.y + self.h))


def find_gaps(walls: Mask, thickness: float) -> list[Gap]:
    """Openings in walls: thin fills of a directional closing (a door, not a corridor)."""
    side = max(walls.shape)
    span = int(np.clip(side * 0.05, 3 * thickness, side * 0.09))
    max_cross = max(4.0, thickness * 1.9)
    gaps: list[Gap] = []
    for horizontal in (True, False):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (span, 1) if horizontal else (1, span))
        closed = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, kernel)
        fill = cv2.bitwise_and(closed, cv2.bitwise_not(walls))
        count, labels, stats, _ = cv2.connectedComponentsWithStats(fill, connectivity=8)
        for i in range(1, count):
            x, y, w, h, area = (int(v) for v in stats[i])
            along, cross = (w, h) if horizontal else (h, w)
            # A door is several wall thicknesses wide; shorter breaks are a broken line.
            if cross > max_cross or along < max(6.0, thickness * 1.6) or along > span:
                continue
            if area < 0.45 * w * h:
                continue
            # Measure along the middle of the wall: the rounded wall ends widen the box.
            if horizontal:
                run = np.flatnonzero(labels[y + h // 2, x : x + w] == i)
                if run.size:
                    x, w = x + int(run[0]), int(run[-1] - run[0] + 1)
            else:
                run = np.flatnonzero(labels[y : y + h, x + w // 2] == i)
                if run.size:
                    y, h = y + int(run[0]), int(run[-1] - run[0] + 1)
            gaps.append(Gap(x, y, w, h, horizontal))
    return gaps


def _side_label(labels: np.ndarray, barrier: Mask, gap: Gap, sign: int, reach: int) -> int:
    """Label of the free area next to a gap on one side (0 = none found)."""
    h, w = labels.shape
    if gap.horizontal:
        cx = gap.x + gap.w // 2
        start = gap.y - 1 if sign < 0 else gap.y + gap.h
        for d in range(reach):
            y = start + sign * d
            if not 0 <= y < h:
                return 0
            if not barrier[y, cx]:
                return int(labels[y, cx])
    else:
        cy = gap.y + gap.h // 2
        start = gap.x - 1 if sign < 0 else gap.x + gap.w
        for d in range(reach):
            x = start + sign * d
            if not 0 <= x < w:
                return 0
            if not barrier[cy, x]:
                return int(labels[cy, x])
    return 0


def _square(ring: np.ndarray, tolerance_deg: float = 9.0) -> list[Point]:
    """Snap almost axis-aligned edges to the axes (plans are drawn square)."""
    pts = [list(map(float, p)) for p in ring]
    n = len(pts)
    tan = np.tan(np.radians(tolerance_deg))
    for _ in range(2):
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]
            if abs(dy) <= abs(dx) * tan:
                y = (a[1] + b[1]) / 2
                a[1] = b[1] = y
            elif abs(dx) <= abs(dy) * tan:
                x = (a[0] + b[0]) / 2
                a[0] = b[0] = x
    out: list[Point] = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 0.5 or abs(p[1] - out[-1][1]) > 0.5:
            out.append((p[0], p[1]))
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) <= 0.5 and abs(out[0][1] - out[-1][1]) <= 0.5:
        out.pop()
    return out


def _grown_labels(free_labels: np.ndarray, barrier: Mask, reach: float) -> np.ndarray:
    """Rooms extended into their walls up to `reach` px: neighbours meet mid-wall."""
    src = np.where(barrier > 0, 255, 0).astype(np.uint8)
    dist, nearest = cv2.distanceTransformWithLabels(
        src, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL
    )
    zero = src == 0
    lut = np.zeros(int(nearest.max()) + 1, np.int32)
    lut[nearest[zero]] = free_labels[zero]
    grown = lut[nearest]
    grown[(src > 0) & (dist > reach)] = 0
    return np.asarray(grown, dtype=np.int32)


# --- stairs and lifts ------------------------------------------------------------------------


def _lines(region: Mask, min_len: float) -> np.ndarray:
    found = cv2.HoughLinesP(
        region, 1, np.pi / 180, threshold=25, minLineLength=max(8, int(min_len)), maxLineGap=4
    )
    return found.reshape(-1, 4) if found is not None else np.zeros((0, 4), int)


def looks_like_stairs(lines_mask: Mask, room_mask: Mask, bbox: tuple[int, int, int, int]) -> bool:
    x, y, w, h = bbox
    region = cv2.bitwise_and(lines_mask, cv2.erode(room_mask, np.ones((5, 5), np.uint8)))
    region = region[y : y + h, x : x + w]
    lines = _lines(region, min(w, h) * 0.3)
    if len(lines) < 5:
        return False
    dy, dx = lines[:, 3] - lines[:, 1], lines[:, 2] - lines[:, 0]
    angles = (np.degrees(np.arctan2(dy, dx)) + 180) % 180
    bins = np.round(angles / 6).astype(int) % 30
    dominant = np.bincount(bins, minlength=30).argmax()
    sel = lines[bins == dominant]
    if len(sel) < 5:
        return False
    theta = np.radians(dominant * 6)
    mid_x = (sel[:, 0] + sel[:, 2]) / 2
    mid_y = (sel[:, 1] + sel[:, 3]) / 2
    offsets = np.sort(-np.sin(theta) * mid_x + np.cos(theta) * mid_y)
    merged = [offsets[0]]
    for value in offsets[1:]:
        if value - merged[-1] > 3:
            merged.append(value)
    if len(merged) < 6:
        return False
    steps = np.diff(merged)
    extent = abs(np.cos(theta)) * h + abs(np.sin(theta)) * w
    regular = float(np.std(steps) / max(np.mean(steps), 1e-6)) < 0.6
    return regular and (merged[-1] - merged[0]) >= 0.35 * extent and np.mean(steps) < 0.25 * extent


def looks_like_lift(lines_mask: Mask, room_mask: Mask, bbox: tuple[int, int, int, int]) -> bool:
    x, y, w, h = bbox
    region = cv2.bitwise_and(lines_mask, cv2.erode(room_mask, np.ones((5, 5), np.uint8)))
    region = region[y : y + h, x : x + w]
    diagonal = float(np.hypot(w, h))
    lines = _lines(region, diagonal * 0.45)
    rising = falling = False
    for x1, y1, x2, y2 in lines:
        angle = (np.degrees(np.arctan2(y2 - y1, x2 - x1)) + 180) % 180
        if 20 <= angle <= 70:
            falling = True
        elif 110 <= angle <= 160:
            rising = True
    return rising and falling


# --- names and categories --------------------------------------------------------------------

CATEGORY_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("stairs", ("лестн", "stair", "л/к")),
    ("elevator", ("лифт", "lift", "elevator")),
    ("restroom", ("туалет", "санузел", "с/у", "wc", "уборн", "душ", "toilet")),
    ("corridor", ("коридор", "corridor", "проход")),
    ("lobby", ("холл", "фойе", "вестибюл", "ресепш", "рецепц", "lobby", "вход")),
    ("hall", ("зал", "аудитор", "конференц", "hall")),
    ("nonpublic", ("техн", "склад", "сервер", "щитов", "подсоб", "кладов", "венткам")),
]
AREA_TOKEN = re.compile(r"^(\d+[.,]\d+|м²|м2|кв\.?м?\.?|m²|m2|s=.*)$", re.IGNORECASE)
FLOOR_RE = re.compile(r"(\d+)\s*[-–]?\s*(?:й|ый|ой|ий)?\s*этаж|этаж\s*[№#]?\s*(\d+)", re.IGNORECASE)


def category_for(text: str) -> str | None:
    low = text.lower().replace("ё", "е")
    for category, keys in CATEGORY_WORDS:
        if any(key in low for key in keys):
            return category
    return None


def room_name(words: Sequence[str]) -> str | None:
    tokens = [w.strip(" .,;:()[]«»\"'") for w in words]
    tokens = [t for t in tokens if t and not AREA_TOKEN.match(t)]
    if not tokens:
        return None
    name = " ".join(tokens)
    if not re.search(r"[A-Za-zА-Яа-яЁё0-9]", name):
        return None
    name = name[:60].strip()
    return name[0].upper() + name[1:] if name else None


def floor_number(text: str) -> int | None:
    match = FLOOR_RE.search(text)
    if not match:
        return None
    value = int(match.group(1) or match.group(2))
    return value if 0 < value < 100 else None


# --- one page --------------------------------------------------------------------------------


@dataclass
class Partition:
    """Walls taken as the strokes at least `k` px thick, and the free areas they enclose."""

    thickness: float
    walls: Mask
    gaps: list[Gap]
    barrier: Mask
    labels: np.ndarray
    stats: np.ndarray
    centroids: np.ndarray
    outside: np.ndarray
    room_ids: list[int]
    score: float  # share of the page covered by plausible rooms


def _partition(dark: Mask, k: int) -> Partition:
    height, width = dark.shape
    walls = extract_walls(dark, k)
    thickness = wall_thickness(walls) if np.any(walls) else 2.0
    gaps = find_gaps(walls, thickness)
    barrier = walls.copy()
    for g in gaps:
        barrier[g.y : g.y + g.h, g.x : g.x + g.w] = 255
    free = cv2.bitwise_not(barrier)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(free, connectivity=4)
    total = width * height
    min_area = total * 0.0008
    outside = np.zeros(count, bool)
    outside[0] = True
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside[border] = True
    room_ids: list[int] = []
    covered = 0
    for i in range(1, count):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if outside[i]:
            continue
        if area > total * 0.45:  # a frame around the drawing: that is the outside
            outside[i] = True
        elif area >= min_area:
            room_ids.append(i)
            covered += area
    return Partition(
        thickness,
        walls,
        gaps,
        barrier,
        labels,
        stats,
        centroids,
        outside,
        room_ids,
        covered / total,
    )


def recognize_page(gray: np.ndarray, words: Sequence[Word] = ()) -> PageResult:
    height, width = gray.shape
    side = max(width, height)
    # Which strokes are walls differs from plan to plan (thick outer walls and thin partitions,
    # or all thin lines): try from the thickest down and keep the split where enclosed rooms
    # cover the most. Too thick leaks rooms into the outside, too thin cuts them up with
    # furniture; both cover less.
    candidates = []
    for mode in ("strict", "otsu", "local"):
        ink = erase_words(binarize(gray, mode), words, side)
        thickest = wall_thickness(ink)
        sizes = {max(0, round(thickest * f)) for f in (0.5, 0.35, 0.22, 0.0)}
        candidates += [(_partition(ink, k), ink) for k in sorted(sizes, reverse=True)]
    best, dark = max(candidates, key=lambda c: (round(c[0].score, 3), len(c[0].room_ids)))
    thickness, gaps, barrier = best.thickness, best.gaps, best.barrier
    labels, stats, centroids, outside = best.labels, best.stats, best.centroids, best.outside
    # Door swings and furniture enclose slivers: far smaller than a typical room, or narrower
    # than a few walls.
    sizes_px = sorted(int(stats[i, cv2.CC_STAT_AREA]) for i in best.room_ids)
    typical = sizes_px[len(sizes_px) // 2] if sizes_px else 0
    room_ids = [
        i
        for i in best.room_ids
        if stats[i, cv2.CC_STAT_AREA] >= typical * 0.1
        and min(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) >= thickness * 3
    ]

    grown = _grown_labels(labels, barrier, thickness * 0.6 + 1)
    rooms: list[Room] = []
    eps = max(2.0, side * 0.003)
    for label in room_ids:
        mask = np.where(grown == label, 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        approx = cv2.approxPolyDP(contour, eps, True).reshape(-1, 2)
        ring = _square(approx)
        if len(ring) < 3:
            continue
        x, y, w, h, area = (int(v) for v in stats[label])
        cx, cy = centroids[label]
        rooms.append(
            Room(
                ring=ring,
                area=float(area),
                center=(float(cx), float(cy)),
                bbox=(x, y, w, h),
                label=label,
            )
        )
    kept = {room.label: n for n, room in enumerate(rooms)}

    openings: list[OpeningCut] = []
    reach = int(thickness * 3 + 4)
    per_pair: dict[tuple[int, ...], int] = {}
    for g in sorted(gaps, key=lambda g: -g.length):
        a_label = _side_label(labels, barrier, g, -1, reach)
        b_label = _side_label(labels, barrier, g, +1, reach)
        a_room, b_room = kept.get(a_label), kept.get(b_label)
        a, b = g.segment
        if a_room is not None and b_room is not None and a_room != b_room:
            pair = (min(a_room, b_room), max(a_room, b_room))
            per_pair[pair] = per_pair.get(pair, 0) + 1
            if per_pair[pair] <= 2:  # two rooms rarely share more than two doors
                openings.append(OpeningCut(a, b, "door", g.length, pair))
        elif (a_room is None) != (b_room is None) and (outside[a_label] or outside[b_label]):
            inner = a_room if a_room is not None else b_room
            assert inner is not None
            inside = dark[g.y : g.y + g.h, g.x : g.x + g.w]
            density = np.count_nonzero(inside) / max(1, inside.size)
            # Glazing lines -> a window; an empty gap is decided once rooms have categories.
            kind = "window" if density > 0.15 else "exterior"
            openings.append(OpeningCut(a, b, kind, g.length, (inner,)))

    # Names, categories, stairs and lifts.
    for word in words:
        cx, cy = word.center
        if 0 <= cx < width and 0 <= cy < height:
            n = kept.get(int(labels[cy, cx]))
            if n is not None:
                rooms[n].words.append(word.text)
    areas = sorted(r.area for r in rooms)
    median_area = areas[len(areas) // 2] if areas else 0.0
    door_count = [0] * len(rooms)
    for o in openings:
        for n in o.rooms:
            door_count[n] += 1
    for n, room in enumerate(rooms):
        text = " ".join(room.words)
        room.name = room_name(room.words)
        category = category_for(text) if text else None
        if category is None:
            mask = np.where(labels == room.label, 255, 0).astype(np.uint8)
            if looks_like_stairs(dark, mask, room.bbox):
                category = "stairs"
            elif room.area <= max(median_area, 1) * 1.2 and looks_like_lift(dark, mask, room.bbox):
                category = "elevator"
        if category is None:
            rect = cv2.minAreaRect(np.array(room.ring, np.float32))
            long_side, short_side = max(rect[1]), max(1e-6, min(rect[1]))
            if long_side / short_side >= 3.2 and door_count[n] >= 2:
                category = "corridor"
            elif median_area and room.area >= 3 * median_area:
                category = "hall"
            else:
                category = "room"
        room.category = category

    # An empty gap in the outer wall is an entrance from a corridor, lobby or hall, a window
    # anywhere else (old plans draw windows as plain gaps). No such gap: the widest one.
    outer = [o for o in openings if o.category == "exterior"]
    for o in outer:
        public = rooms[o.rooms[0]].category in ("corridor", "lobby", "hall")
        o.category = "entrance" if public else "window"
    if outer and not any(o.category == "entrance" for o in openings):
        max(outer, key=lambda o: o.width_px).category = "entrance"
    page_text = " ".join(w.text for w in words)
    return PageResult(
        width=width,
        height=height,
        rooms=rooms,
        openings=openings,
        wall_px=thickness,
        floor=floor_number(page_text),
        text=page_text,
    )


# --- floors ----------------------------------------------------------------------------------


def _bbox_of(rooms: Sequence[Room]) -> tuple[float, float, float, float]:
    xs = [p[0] for r in rooms for p in r.ring]
    ys = [p[1] for r in rooms for p in r.ring]
    return min(xs), min(ys), max(1.0, max(xs) - min(xs)), max(1.0, max(ys) - min(ys))


def link_floors(pages: Sequence[PageResult], tolerance: float = 0.12) -> list[dict[str, Any]]:
    """Stairs and lifts at the same place (relative to the building) on consecutive floors."""
    spots: list[list[tuple[str, int, float, float]]] = []
    for page in pages:
        if not page.rooms:
            spots.append([])
            continue
        x0, y0, bw, bh = _bbox_of(page.rooms)
        spots.append(
            [
                (r.category, n, (r.center[0] - x0) / bw, (r.center[1] - y0) / bh)
                for n, r in enumerate(page.rooms)
                if r.category in ("stairs", "elevator")
            ]
        )
    taken: set[tuple[int, int]] = set()
    chains: list[dict[str, Any]] = []
    for p in range(len(pages) - 1):
        for kind, n, u, v in spots[p]:
            if (p, n) in taken:
                continue
            members = [{"page": p, "room": n}]
            q, cu, cv = p, u, v
            while q + 1 < len(pages):
                best = min(
                    (
                        (np.hypot(u2 - cu, v2 - cv), n2, u2, v2)
                        for kind2, n2, u2, v2 in spots[q + 1]
                        if kind2 == kind and (q + 1, n2) not in taken
                    ),
                    default=None,
                )
                if best is None or best[0] > tolerance:
                    break
                q, cu, cv = q + 1, best[2], best[3]
                members.append({"page": q, "room": best[1]})
                taken.add((q, best[1]))
            if len(members) > 1:
                taken.add((p, n))
                chains.append({"kind": kind, "rooms": members})
    return chains


# --- whole file ------------------------------------------------------------------------------


def meters_per_pixel(pages: Sequence[PageResult]) -> float | None:
    """A door is ~0.9 m: the median door width of all pages gives the scale."""
    widths = [w for page in pages for w in page.door_widths()]
    if len(widths) < 2:
        return None
    return DOOR_WIDTH_M / float(np.median(widths))


def page_json(page: PageResult) -> dict[str, Any]:
    fx, fy = 1 / page.width, 1 / page.height

    def norm(p: Point) -> list[float]:
        return [round(p[0] * fx, 5), round(p[1] * fy, 5)]

    return {
        "width": page.width,
        "height": page.height,
        "floor": page.floor,
        "wallPx": round(page.wall_px, 2),
        "rooms": [
            {
                "ring": [norm(p) for p in [*r.ring, r.ring[0]]],
                "name": r.name,
                "category": r.category,
                "center": norm(r.center),
            }
            for r in page.rooms
        ],
        "openings": [
            {"a": norm(o.a), "b": norm(o.b), "category": o.category, "rooms": list(o.rooms)}
            for o in page.openings
        ],
    }


def recognize_file(
    path: Path,
    progress: Callable[[float], None] = lambda _: None,
    ocr: Ocr | None = None,
) -> tuple[dict[str, Any], list[np.ndarray]]:
    """The file -> (result JSON, page images for underlays). Floors follow the pages, or the
    "N этаж" written on them when every page has one."""
    pages_gray = load_pages(path)
    ocr = ocr or Ocr()
    results: list[PageResult] = []
    for i, gray in enumerate(pages_gray):
        words = ocr.words(gray)
        progress((i + 0.5) / len(pages_gray))
        results.append(recognize_page(gray, words))
        progress((i + 1) / len(pages_gray))
    order = list(range(len(results)))
    floors = [r.floor for r in results]
    if all(f is not None for f in floors) and len(set(floors)) == len(floors):
        order.sort(key=lambda i: floors[i] or 0)
    ordered = [results[i] for i in order]
    images = [pages_gray[i] for i in order]
    warnings = []
    if not ocr.available:
        warnings.append("Подписи не распознаны: на сервере нет Tesseract")
    if not any(page.rooms for page in ordered):
        warnings.append("Помещений не нашлось: нужен чёткий план с тёмными стенами")
    mpp = meters_per_pixel(ordered)
    if mpp is None:
        warnings.append("Масштаб не определён по дверям: задайте ширину здания")
    result = {
        "pages": [{**page_json(p), "sourcePage": order[n] + 1} for n, p in enumerate(ordered)],
        "connectors": link_floors(ordered),
        "metersPerPixel": mpp,
        "ocr": ocr.available,
        "warnings": warnings,
    }
    return result, images
