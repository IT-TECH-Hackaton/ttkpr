"""Demo data for a fresh deployment: test accounts for every role and a published demo map.

    uv run --package api python -m api.seed            # dev (repo paths)
    docker compose --profile seed run --rm seed         # full stack (infra/docker-compose.yml)

Idempotent: accounts get new passwords (unless --keep-passwords), the demo map is created once
and re-published from the fixture on every run. Prints the
accounts as a Markdown table (stdout) — keep it out of git (data/ is ignored).
"""

import argparse
import asyncio
import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.accounts import readable_password
from api.config import REPO_ROOT
from api.db import get_sessionmaker
from api.models import (
    AccessMode,
    Map,
    MapMember,
    MapVersion,
    MemberRole,
    Panorama,
    PanoramaStatus,
    User,
    VersionStatus,
)
from api.security import hash_password
from api.storage import get_storage
from map_schema.models import MapDocument, Pano, PanoStatus, PanoTiles

DEMO_TITLE = "Демо-площадка хакатона"
DEMO_SLUG = "demo-ploschadka-hakatona"

ACCOUNTS = [
    ("owner@example.com", "Организатор (владелец)", MemberRole.OWNER),
    ("editor@example.com", "Редактор плана", MemberRole.EDITOR),
    ("photographer@example.com", "Съёмщик панорам", MemberRole.PHOTOGRAPHER),
    ("viewer@example.com", "Наблюдатель", MemberRole.VIEWER),
]


def _copy_tiles(source: Path, pano_id: uuid.UUID) -> dict[str, Any]:
    """Demo scene tiles -> storage, the same layout the worker writes."""
    storage = get_storage()
    key = f"panos/{pano_id}/tiles"
    target = storage.path(key)
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(source, target)
    levels = sorted(
        (int(p.name) for p in target.iterdir() if p.is_dir() and p.name.isdigit()),
    )
    return PanoTiles.model_validate(
        {
            "baseUrl": storage.url(key),
            "previewUrl": storage.url(f"{key}/preview.webp"),
            "levels": [{"width": w, "cols": w // 512, "rows": w // 1024} for w in levels],
        }
    ).model_dump(mode="json", by_alias=True)


async def _sync_demo_panos(
    db: AsyncSession, demo: Map, fixture_panos: list[dict[str, Any]], demo_dir: Path
) -> None:
    """One panorama per fixture pano, tagged with its fixture id; tiles from {demo_dir}/{id}/."""
    existing = list(await db.scalars(select(Panorama).where(Panorama.map_id == demo.id)))
    tagged = {p.capture_meta["demoId"]: p for p in existing if p.capture_meta.get("demoId")}
    for item in fixture_panos:
        lon, lat = item["position"]
        pano = tagged.get(item["id"]) or next(
            # Seeded before panoramas were tagged: exactly where the fixture puts them.
            (
                p
                for p in existing
                if p.source == "upload"
                and not p.capture_meta
                and abs(p.lon - lon) < 1e-9
                and abs(p.lat - lat) < 1e-9
            ),
            None,
        )
        if pano is None:
            pano = Panorama(map_id=demo.id, source="upload")
            db.add(pano)
        pano.level_id = item["levelId"]
        pano.lon, pano.lat = lon, lat
        pano.heading_deg = item.get("headingDeg", 0.0)
        pano.camera_height_m = item.get("cameraHeightM", 1.5)
        pano.status = PanoramaStatus.READY
        pano.progress = 100
        pano.capture_meta = {"demoId": item["id"]}
        await db.flush()
        source = demo_dir / Path(item["tiles"]["baseUrl"]).name
        pano.tiles = _copy_tiles(source, pano.id)


async def seed(
    document: dict[str, Any], demo_dir: Path, keep_passwords: bool = False
) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    async with get_sessionmaker()() as db:
        users: dict[str, User] = {}
        for email, name, role in ACCOUNTS:
            password = readable_password()
            user = await db.scalar(select(User).where(User.email == email))
            if user is None:
                user = User(email=email, name=name, password_hash=hash_password(password))
                db.add(user)
            elif keep_passwords:
                password = "(не менялся)"
            else:
                user.password_hash = hash_password(password)
            users[email] = user
            rows.append((email, password, role.value, name))
        await db.flush()

        # The demo map follows the fixture: created once, then re-published on every run with the
        # current plan (tours, walkways...), the fixture's panoramas and any added in the studio.
        fixture_panos = document.pop("panos", [])
        document["venue"] = {**document["venue"], "id": DEMO_SLUG, "name": DEMO_TITLE}
        draft = MapDocument.model_validate(document).model_dump(mode="json", by_alias=True)
        demo = await db.scalar(select(Map).where(Map.slug == DEMO_SLUG))
        if demo is None:
            demo = Map(slug=DEMO_SLUG, title=DEMO_TITLE, draft=draft, access_mode=AccessMode.LINK)
            db.add(demo)
            await db.flush()
        else:
            demo.draft = draft
            demo.draft_version += 1
        await _sync_demo_panos(db, demo, fixture_panos, demo_dir)

        ready = await db.scalars(
            select(Panorama).where(
                Panorama.map_id == demo.id, Panorama.status == PanoramaStatus.READY
            )
        )
        panos = [
            Pano(
                id=str(p.id),
                level_id=p.level_id,
                position=(p.lon, p.lat),
                heading_deg=p.heading_deg,
                camera_height_m=p.camera_height_m,
                status=PanoStatus.READY,
                tiles=PanoTiles.model_validate(p.tiles),
            )
            for p in ready
            if p.tiles
        ]
        bundle = MapDocument.model_validate(draft).model_copy(update={"panos": panos})
        last = await db.scalar(
            select(func.max(MapVersion.number)).where(MapVersion.map_id == demo.id)
        )
        version = MapVersion(
            map_id=demo.id,
            number=(last or 0) + 1,
            status=VersionStatus.READY,
            bundle=bundle.model_dump(mode="json", by_alias=True),
        )
        db.add(version)
        await db.flush()
        demo.published_version_id = version.id

        existing = await db.scalars(select(MapMember).where(MapMember.map_id == demo.id))
        members = {m.user_id: m for m in existing}
        for email, _name, role in ACCOUNTS:
            user = users[email]
            if user.id in members:
                members[user.id].role = role
            else:
                db.add(MapMember(map_id=demo.id, user_id=user.id, role=role))
        await db.commit()
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=REPO_ROOT / "fixtures" / "demo-map.json")
    demo_dir = REPO_ROOT / "apps" / "viewer" / "public" / "demo"
    parser.add_argument(
        "--demo-dir", type=Path, default=demo_dir, help="tiles of the fixture's panoramas"
    )
    parser.add_argument(
        "--keep-passwords", action="store_true", help="existing accounts keep their passwords"
    )
    args = parser.parse_args()
    document = json.loads(args.fixture.read_text(encoding="utf-8"))
    rows = asyncio.run(seed(document, args.demo_dir, args.keep_passwords))
    print(f"# Тестовые аккаунты\n\nКарта: «{DEMO_TITLE}», адрес /m/{DEMO_SLUG}\n")
    print("| Email | Пароль | Роль | Имя |\n| --- | --- | --- | --- |")
    for email, password, role, name in rows:
        print(f"| {email} | {password} | {role} | {name} |")


if __name__ == "__main__":
    main()
