"""Sliding-window rate limits shared by every API process (Redis), with an in-process fallback.

A bucket is a sorted set of hit times in Redis with a TTL of one window, so all uvicorn workers
(and API containers) count together. Redis being down never fails a request: this process
counts on its own for RETRY_AFTER_S, then tries Redis again.
"""

import asyncio
import hashlib
import logging
import secrets
import time
from collections import deque

import redis
from fastapi import HTTPException, Request, status
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from redis.commands.core import AsyncScript
from redis.retry import Retry as SyncRetry

from api.config import get_settings

log = logging.getLogger(__name__)

KEY_PREFIX = "ttk:rl:"
# Redis sits next to the API: anything slower means it is overloaded or gone.
TIMEOUT_S = 0.5
RETRY_AFTER_S = 30.0
MAX_MEMORY_BUCKETS = 20_000

# KEYS[1] = bucket; ARGV = window (s), max hits, unique member. Redis' own clock keeps every
# process on one timeline. Refused attempts are not recorded, as in the in-process limiter.
SLIDING_WINDOW = """
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])
local window = tonumber(ARGV[1]) * 1000000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 1000)
return 1
"""

# Fallback: bucket -> (window, hit times).
_hits: dict[str, tuple[int, deque[float]]] = {}
# asyncio connections belong to the event loop that opened them (tests run a loop per test).
_redis: tuple[asyncio.AbstractEventLoop, Redis, AsyncScript] | None = None
_redis_down_until = 0.0


def _bucket_key(request: Request, bucket: str, subject: str) -> str:
    # request.client is the real peer: uvicorn --proxy-headers resolves it from the proxy chain,
    # so a client-supplied X-Forwarded-For cannot dodge the limit. `subject` narrows the bucket
    # (an email), so people behind one NAT do not lock each other out; hashed, so Redis holds
    # no emails.
    peer = request.client.host if request.client else "?"
    narrowed = hashlib.sha256(subject.encode()).hexdigest()[:16] if subject else ""
    return f"{KEY_PREFIX}{bucket}:{peer}:{narrowed}"


def _script() -> AsyncScript | None:
    global _redis
    if time.monotonic() < _redis_down_until:
        return None
    loop = asyncio.get_running_loop()
    if _redis is None or _redis[0] is not loop:
        client = Redis.from_url(
            get_settings().redis_url,
            socket_connect_timeout=TIMEOUT_S,
            socket_timeout=TIMEOUT_S,
            retry=Retry(NoBackoff(), 0),
        )
        _redis = (loop, client, client.register_script(SLIDING_WINDOW))
    return _redis[2]


async def _redis_hit(key: str, max_hits: int, window_s: int) -> bool | None:
    """Allowed or not according to Redis; None if Redis cannot answer right now."""
    global _redis_down_until
    script = _script()
    if script is None:
        return None
    try:
        allowed = await asyncio.wait_for(
            script(keys=[key], args=[window_s, max_hits, secrets.token_hex(8)]),
            timeout=TIMEOUT_S * 2,
        )
    except (redis.RedisError, OSError, TimeoutError) as exc:
        _redis_down_until = time.monotonic() + RETRY_AFTER_S
        log.warning("rate limit: Redis unavailable (%r), counting in-process for now", exc)
        return None
    return bool(allowed)


def _memory_hit(key: str, max_hits: int, window_s: int) -> bool:
    now = time.monotonic()
    if len(_hits) > MAX_MEMORY_BUCKETS:
        # Forget buckets whose last hit has left their window: memory stays bounded.
        for stale in [k for k, (w, hits) in _hits.items() if not hits or hits[-1] <= now - w]:
            del _hits[stale]
    _, hits = _hits.setdefault(key, (window_s, deque()))
    while hits and hits[0] <= now - window_s:
        hits.popleft()
    if len(hits) >= max_hits:
        return False
    hits.append(now)
    return True


async def limit(
    request: Request, bucket: str, max_hits: int, window_s: int, subject: str = ""
) -> None:
    """At most `max_hits` per `window_s` seconds per client (and subject); 429 otherwise."""
    key = _bucket_key(request, bucket, subject)
    allowed = await _redis_hit(key, max_hits, window_s)
    if allowed is None:
        allowed = _memory_hit(key, max_hits, window_s)
    if not allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток — подождите пару минут"
        )


def reset() -> None:
    """Tests: forget every counter, in this process and in Redis, and use Redis again."""
    global _redis, _redis_down_until
    _hits.clear()
    _redis = None
    _redis_down_until = 0.0
    try:
        with redis.Redis.from_url(
            get_settings().redis_url,
            socket_connect_timeout=TIMEOUT_S,
            socket_timeout=TIMEOUT_S,
            retry=SyncRetry(NoBackoff(), 0),
        ) as sync:
            keys = list(sync.scan_iter(match=f"{KEY_PREFIX}*", count=1000))
            if keys:
                sync.delete(*keys)
    except (redis.RedisError, OSError):
        pass


async def aclose() -> None:
    """Closes the Redis connections of the running event loop (tests, shutdown)."""
    global _redis
    if _redis is not None and _redis[0] is asyncio.get_running_loop():
        await _redis[1].aclose()
    _redis = None
