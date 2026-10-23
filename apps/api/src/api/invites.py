"""Signed invite links: "join map M as role R", valid for a week, any number of uses.

Separate HMAC purpose from capture tokens, so one can never be replayed as the other.
"""

import base64
import hashlib
import hmac
import time
import uuid

from api.config import get_settings
from api.models import MemberRole

INVITE_TTL_S = 7 * 24 * 3600


def _sign(payload: str) -> str:
    key = get_settings().secret_key.encode()
    digest = hmac.new(key, f"invite:{payload}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest[:18]).decode().rstrip("=")


def issue(map_id: uuid.UUID, role: MemberRole) -> tuple[str, int]:
    expires = int(time.time()) + INVITE_TTL_S
    payload = f"{map_id.hex}.{role.value}.{expires}"
    return f"{payload}.{_sign(payload)}", expires


def verify(token: str) -> tuple[uuid.UUID, MemberRole] | None:
    try:
        map_hex, role, expires, signature = token.split(".")
        payload = f"{map_hex}.{role}.{expires}"
        if not hmac.compare_digest(signature, _sign(payload)) or int(expires) < time.time():
            return None
        parsed_role = MemberRole(role)
        if parsed_role == MemberRole.OWNER:
            return None
        return uuid.UUID(map_hex), parsed_role
    except ValueError:
        return None
