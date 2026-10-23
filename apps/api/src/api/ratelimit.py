"""In-process sliding-window limiter for auth endpoints (one API instance per deployment)."""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

_hits: dict[str, deque[float]] = defaultdict(deque)


def limit(request: Request, bucket: str, max_hits: int, window_s: int) -> None:
    # request.client is the real peer: uvicorn --proxy-headers resolves it from the proxy chain,
    # so a client-supplied X-Forwarded-For cannot dodge the limit.
    key = f"{bucket}:{request.client.host if request.client else '?'}"
    now = time.monotonic()
    hits = _hits[key]
    while hits and hits[0] < now - window_s:
        hits.popleft()
    if len(hits) >= max_hits:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток — подождите пару минут"
        )
    hits.append(now)


def reset() -> None:
    _hits.clear()
