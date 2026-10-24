"""Plan recognition on a drawn plan with known rooms, doors, a window, stairs and a lift."""

from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
import pytest

from worker.plan_import import (
    Ocr,
    category_for,
    floor_number,
    link_floors,
    recognize_file,
    recognize_page,
    room_name,
)

WALL = 12
DOOR = 50  # px; the scale test expects 0.9 m per door


def _door(img: np.ndarray, x: int, y: int, into: int) -> None:
    """A gap of DOOR px in a horizontal wall at y, with a thin leaf and swing arc into the room."""
    cv2.rectangle(img, (x, y - WALL // 2), (x + DOOR, y + WALL // 2), 255, -1)
    cv2.line(img, (x, y), (x, y + into * DOOR), 0, 2)
    cv2.ellipse(img, (x, y), (DOOR, DOOR), 0, 0 if into > 0 else -90, 90 if into > 0 else 0, 0, 2)


def draw_plan(entrance: bool = True) -> np.ndarray:
    """1600x1100: four rooms above a corridor (the last one is stairs), four below (the last a
    lift); an entrance into the corridor and a window in the first room."""
    img = np.full((1100, 1600), 255, np.uint8)
    box = (100, 100, 1500, 1000)
    cv2.rectangle(img, box[:2], box[2:], 0, WALL)
    for y in (500, 620):
        cv2.line(img, (100, y), (1500, y), 0, WALL)
    for x in (500, 900, 1200):
        cv2.line(img, (x, 100), (x, 500), 0, WALL)
    for x in (600, 1000, 1300):
        cv2.line(img, (x, 620), (x, 1000), 0, WALL)
    for x in (250, 650, 1000, 1300):
        _door(img, x, 500, -1)
    for x in (300, 750, 1200, 1380):
        _door(img, x, 620, +1)
    if entrance:
        cv2.rectangle(img, (100 - WALL // 2, 535), (100 + WALL // 2, 585), 255, -1)
        # Window: a gap in the outer wall with thin glazing lines in it.
        cv2.rectangle(img, (300, 100 - WALL // 2), (360, 100 + WALL // 2), 255, -1)
        for dy in (-4, 0, 4):
            cv2.line(img, (300, 100 + dy), (360, 100 + dy), 0, 1)
    # Stairs: evenly spaced steps.
    for y in range(150, 460, 25):
        cv2.line(img, (1230, y), (1470, y), 0, 2)
    # Lift: a cross.
    cv2.line(img, (1320, 640), (1480, 980), 0, 2)
    cv2.line(img, (1480, 640), (1320, 980), 0, 2)
    # Furniture is not a wall.
    cv2.rectangle(img, (180, 250), (380, 330), 0, 2)
    return img


class NoOcr(Ocr):
    def __init__(self) -> None:
        self.binary = None
        self.langs = ""


def test_rooms_doors_window_stairs_and_lift() -> None:
    page = recognize_page(draw_plan())
    categories = sorted(r.category for r in page.rooms)
    assert len(page.rooms) == 9, categories
    assert categories.count("corridor") == 1
    assert categories.count("stairs") == 1
    assert categories.count("elevator") == 1
    kinds = [o.category for o in page.openings]
    assert kinds.count("door") == 8
    assert kinds.count("entrance") == 1
    assert kinds.count("window") == 1
    assert all(abs(w - DOOR) <= 4 for w in page.door_widths())
    # Rooms grow to the middle of the walls: neighbours share their boundary.
    corridor = next(r for r in page.rooms if r.category == "corridor")
    ys = sorted({round(p[1]) for p in corridor.ring})
    assert abs(ys[0] - 500) <= 4 and abs(ys[-1] - 620) <= 4


def test_floors_link_stairs_and_lifts() -> None:
    pages = [recognize_page(draw_plan()), recognize_page(draw_plan(entrance=False))]
    chains = link_floors(pages)
    assert sorted(c["kind"] for c in chains) == ["elevator", "stairs"]
    for chain in chains:
        assert [m["page"] for m in chain["rooms"]] == [0, 1]


def _pdf(path: Path, images: list[np.ndarray]) -> None:
    pdf = pdfium.PdfDocument.new()
    for n, img in enumerate(images):
        jpg = path.parent / f"p{n}.jpg"
        cv2.imwrite(str(jpg), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        image = pdfium.PdfImage.new(pdf)
        image.load_jpeg(str(jpg))
        w, h = img.shape[1], img.shape[0]
        image.set_matrix(pdfium.PdfMatrix().scale(w, h))
        page = pdf.new_page(w, h)
        page.insert_obj(image)
        page.gen_content()
    pdf.save(str(path))


def test_multi_page_pdf(tmp_path: Path) -> None:
    source = tmp_path / "plan.pdf"
    _pdf(source, [draw_plan(), draw_plan(entrance=False)])
    result, images = recognize_file(source, ocr=NoOcr())
    assert len(result["pages"]) == len(images) == 2
    assert all(len(p["rooms"]) == 9 for p in result["pages"])
    assert len(result["connectors"]) == 2
    # 50 px doors at 1600 px -> the page is 1600 * 0.9 / 50 = 28.8 m wide.
    page = result["pages"][0]
    assert page["width"] * result["metersPerPixel"] == pytest.approx(28.8, rel=0.1)
    ring = page["rooms"][0]["ring"]
    assert all(0 <= x <= 1 and 0 <= y <= 1 for x, y in ring)
    assert "Tesseract" in " ".join(result["warnings"])


def test_image_file(tmp_path: Path) -> None:
    source = tmp_path / "plan.png"
    cv2.imwrite(str(source), draw_plan())
    result, _ = recognize_file(source, ocr=NoOcr())
    assert len(result["pages"]) == 1 and len(result["pages"][0]["rooms"]) == 9


def test_names_and_categories() -> None:
    assert category_for("Лестничная клетка") == "stairs"
    assert category_for("ЛИФТ") == "elevator"
    assert category_for("С/у") == "restroom"
    assert category_for("Конференц-зал") == "hall"
    assert category_for("Кабинет") is None
    assert room_name(["Переговорная", "18,5", "м²"]) == "Переговорная"
    assert room_name(["101"]) == "101"
    assert room_name(["—"]) is None
    assert floor_number("План 2 этажа") is None or floor_number("План 2 этажа") == 2
    assert floor_number("3 этаж") == 3
    assert floor_number("ЭТАЖ 4") == 4
