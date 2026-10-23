from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select

from api.deps import AppSettings, CurrentUser, DbSession
from api.models import Session, User
from api.schemas import LoginRequest, RegisterRequest, UserOut
from api.security import hash_password, hash_token, new_session_token, verify_password

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
    body: RegisterRequest, response: Response, db: DbSession, settings: AppSettings
) -> User:
    email = body.email.lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже есть")
    user = User(email=email, name=body.name, password_hash=hash_password(body.password))
    db.add(user)
    await db.flush()
    await _start_session(db, settings, user, response)
    return user


@router.post("/login", response_model=UserOut)
async def login(
    body: LoginRequest, response: Response, db: DbSession, settings: AppSettings
) -> User:
    user = await db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None or not verify_password(user.password_hash, body.password):
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
