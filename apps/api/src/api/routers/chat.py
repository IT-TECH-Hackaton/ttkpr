"""Chat with the organizers: a visitor asks from the map, the team answers in the studio.

A thread is one visitor's conversation. Its id is created on the first message and kept only on
the visitor's device, so it works as the key to read the answers: no accounts for visitors.
"""

import uuid
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from api import ratelimit
from api.access import member_map
from api.deps import CurrentUser, DbSession
from api.models import ChatMessage
from api.permissions import Permission
from api.routers.public import published_map
from api.schemas import ChatMessageOut, ChatPost, ChatReply, ChatThreadOut

router = APIRouter(tags=["chat"])

CHAT_MESSAGES = 20
CHAT_WINDOW_S = 600
MAX_THREADS = 100


async def _thread(db: DbSession, map_id: uuid.UUID, thread: uuid.UUID) -> list[ChatMessage]:
    rows = await db.scalars(
        select(ChatMessage)
        .where(ChatMessage.map_id == map_id, ChatMessage.thread == thread)
        .order_by(ChatMessage.created_at)
    )
    return list(rows)


def _out(thread: uuid.UUID, messages: list[ChatMessage]) -> ChatThreadOut:
    return ChatThreadOut(
        thread=thread, messages=[ChatMessageOut.model_validate(m) for m in messages]
    )


@router.post("/api/public/maps/{slug}/chat", response_model=ChatThreadOut)
async def post_chat(slug: str, body: ChatPost, request: Request, db: DbSession) -> ChatThreadOut:
    """A visitor's question; without `thread` a new conversation starts."""
    found = await published_map(db, slug, request)
    await ratelimit.limit(request, "chat", CHAT_MESSAGES, CHAT_WINDOW_S, subject=slug)
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Пустое сообщение")
    thread = body.thread or uuid.uuid4()
    name = (body.name or "").strip() or None
    db.add(ChatMessage(map_id=found.id, thread=thread, author="visitor", name=name, text=text))
    await db.commit()
    return _out(thread, await _thread(db, found.id, thread))


@router.get("/api/public/maps/{slug}/chat/{thread}", response_model=ChatThreadOut)
async def get_chat(slug: str, thread: uuid.UUID, request: Request, db: DbSession) -> ChatThreadOut:
    """The visitor's conversation, polled while the chat is open."""
    found = await published_map(db, slug, request)
    return _out(thread, await _thread(db, found.id, thread))


@router.get("/api/maps/{map_id}/chat", response_model=list[ChatThreadOut])
async def list_chat(map_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[ChatThreadOut]:
    """Conversations with visitors, the most recent first."""
    await member_map(db, map_id, user, Permission.VIEW)
    rows = await db.scalars(
        select(ChatMessage).where(ChatMessage.map_id == map_id).order_by(ChatMessage.created_at)
    )
    threads: dict[uuid.UUID, list[ChatMessage]] = defaultdict(list)
    for message in rows:
        threads[message.thread].append(message)
    ordered = sorted(threads.items(), key=lambda kv: kv[1][-1].created_at, reverse=True)
    return [_out(thread, messages) for thread, messages in ordered[:MAX_THREADS]]


@router.post("/api/maps/{map_id}/chat/{thread}", response_model=ChatThreadOut)
async def reply_chat(
    map_id: uuid.UUID, thread: uuid.UUID, body: ChatReply, db: DbSession, user: CurrentUser
) -> ChatThreadOut:
    """The team's answer; the visitor sees it on the next poll."""
    await member_map(db, map_id, user, Permission.EDIT)
    if not await _thread(db, map_id, thread):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Переписка не найдена")
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Пустое сообщение")
    db.add(ChatMessage(map_id=map_id, thread=thread, author="organizer", name=user.name, text=text))
    await db.commit()
    return _out(thread, await _thread(db, map_id, thread))
