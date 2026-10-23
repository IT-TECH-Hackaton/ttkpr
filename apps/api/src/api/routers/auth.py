from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete, select

from api import ratelimit
from api.deps import AppSettings, CurrentUser, DbSession
from api.models import Session, User
from api.schemas import LoginRequest, PasswordChange, ProfileUpdate, RegisterRequest, UserOut
from api.security import (
    dummy_hash,
    hash_password,
    hash_token,
    new_session_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


async def _start_session(
    db: DbSession, settings: AppSettings, user: User, response: Response
) -> None:
    token, token_hash = new_session_token()
    ttl = timedelta(days=settings.session_ttl_days)
    db.add(Session(user_id=user.id, token_hash=token_hash, expires_at=datetime.now(UTC) + ttl))
    await db.commit()
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=int(ttl.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
) -> User:
    ratelimit.limit(request, "register", max_hits=60, window_s=3600)
    email = body.email.lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже есть")
    password_hash = await run_in_threadpool(hash_password, body.password)
    user = User(email=email, name=body.name, password_hash=password_hash)
    db.add(user)
    await db.flush()
    await _start_session(db, settings, user, response)
    return user


@router.post("/login", response_model=UserOut)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: DbSession,
    settings: AppSettings,
) -> User:
    email = body.email.lower()
    ratelimit.limit(request, "login", max_hits=10, window_s=300, subject=email)
    ratelimit.limit(request, "login-ip", max_hits=200, window_s=300)
    user = await db.scalar(select(User).where(User.email == email))
    # Unknown emails cost the same argon2 time, so timing does not reveal who is registered.
    known = user.password_hash if user else dummy_hash()
    if not await run_in_threadpool(verify_password, known, body.password) or user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный email или пароль")
    await _start_session(db, settings, user, response)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request, response: Response, db: DbSession, settings: AppSettings
) -> None:
    token = request.cookies.get(settings.session_cookie)
    if token:
        await db.execute(delete(Session).where(Session.token_hash == hash_token(token)))
        await db.commit()
    response.delete_cookie(settings.session_cookie, path="/")


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.patch("/me", response_model=UserOut)
async def update_profile(body: ProfileUpdate, db: DbSession, user: CurrentUser) -> User:
    user.name = body.name.strip()
    await db.commit()
    return user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChange,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    settings: AppSettings,
) -> None:
    """Also signs out every other device: a changed password must lock out a stolen session."""
    ratelimit.limit(request, "password", max_hits=10, window_s=300)
    if not await run_in_threadpool(verify_password, user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Текущий пароль указан неверно")
    user.password_hash = await run_in_threadpool(hash_password, body.new_password)
    current = hash_token(request.cookies.get(settings.session_cookie, ""))
    await db.execute(
        delete(Session).where(Session.user_id == user.id, Session.token_hash != current)
    )
    await db.commit()


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_everywhere(
    response: Response, db: DbSession, user: CurrentUser, settings: AppSettings
) -> None:
    await db.execute(delete(Session).where(Session.user_id == user.id))
    await db.commit()
    response.delete_cookie(settings.session_cookie, path="/")
