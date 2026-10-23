"""Short-lived signed tokens that let a phone upload panorama frames for one map.

The desktop editor shows a QR code with the token in the URL fragment, so the phone can
shoot without logging in. A token grants capture on that map only, until it expires.
"""

import base64
import hashlib
import hmac
import time
import uuid

from api.config import get_settings


def _sign(payload: str) -> str:
    key = get_settings().secret_key.encode()
    digest = hmac.new(key, payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest[:18]).decode().rstrip("=")


def issue(map_id: uuid.UUID, user_id: uuid.UUID) -> tuple[str, int]:
    expires = int(time.time()) + get_settings().capture_token_ttl_minutes * 60
    payload = f"{map_id.hex}.{user_id.hex}.{expires}"
    return f"{payload}.{_sign(payload)}", expires


def verify(token: str, map_id: uuid.UUID) -> uuid.UUID | None:
    """Returns the issuing user's id if the token is valid for this map."""
    try:
        map_hex, user_hex, expires, signature = token.split(".")
        payload = f"{map_hex}.{user_hex}.{expires}"
        if not hmac.compare_digest(signature, _sign(payload)):
            return None
        if map_hex != map_id.hex or int(expires) < time.time():
            return None
        return uuid.UUID(user_hex)
    except ValueError:
        return None


def map_of(token: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(token.split(".", 1)[0])
    except ValueError:
        return None
