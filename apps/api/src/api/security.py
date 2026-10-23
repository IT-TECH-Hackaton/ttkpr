import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError

_hasher = PasswordHasher()
_dummy: str | None = None


def dummy_hash() -> str:
    """A real hash of nothing in particular, verified when the email is unknown."""
    global _dummy
    if _dummy is None:
        _dummy = _hasher.hash(secrets.token_urlsafe(16))
    return _dummy


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerificationError:
        return False


def new_session_token() -> tuple[str, str]:
    """Returns (token for the cookie, sha256 hash for the database)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
