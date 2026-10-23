"""Organizer accounts from the command line — handy for a demo or for handing out access:

    python -m api.accounts create team@example.com "Команда" --role owner \
        --map demo-ploschadka-hakatona

    # full stack (infra/docker-compose.yml):
    docker compose -f infra/docker-compose.yml --env-file infra/.env exec api \\
        python -m api.accounts create team@example.com "Команда" --map demo-ploschadka-hakatona

Prints a Markdown row with the generated password (shown once). An existing account gets a new
password; with --map the account joins that map's team with the given role.
"""

import argparse
import asyncio
import secrets

from sqlalchemy import select

from api.db import get_sessionmaker
from api.models import Map, MapMember, MemberRole, User
from api.security import hash_password


def readable_password() -> str:
    """Easy to type on a phone: three groups of letters and digits (~60 bits)."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))


async def create(email: str, name: str, role: MemberRole, slug: str | None) -> str:
    password = readable_password()
    async with get_sessionmaker()() as db:
        user = await db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, name=name, password_hash=hash_password(password))
            db.add(user)
            await db.flush()
        else:
            user.name = name
            user.password_hash = hash_password(password)
        if slug:
            found = await db.scalar(select(Map).where(Map.slug == slug))
            if found is None:
                raise SystemExit(f"Карта /m/{slug} не найдена")
            member = await db.scalar(
                select(MapMember).where(MapMember.map_id == found.id, MapMember.user_id == user.id)
            )
            if member is None:
                db.add(MapMember(map_id=found.id, user_id=user.id, role=role))
            else:
                member.role = role
        await db.commit()
    return password


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("create", help="create an account or reset its password")
    add.add_argument("email")
    add.add_argument("name")
    add.add_argument(
        "--role", choices=[r.value for r in MemberRole], default=MemberRole.OWNER.value
    )
    add.add_argument("--map", dest="slug", help="add to this map's team (its /m/<slug>)")
    args = parser.parse_args()
    email = args.email.strip().lower()
    password = asyncio.run(create(email, args.name, MemberRole(args.role), args.slug))
    print(f"| {email} | {password} | {args.role} | {args.name} |")


if __name__ == "__main__":
    main()
