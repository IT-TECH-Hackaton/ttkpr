"""Conditional JSON for small files visitors poll (manifest, live statuses): ETag and 304."""

import hashlib
import json
from typing import Any

from fastapi import Request, Response, status

# A compressing proxy may mark the tag weak (W/"…") or append the encoding ("…-gzip"); it still
# names the same content.
_ENCODING_SUFFIXES = ("-gzip", "-br", "-zstd")


def _opaque(tag: str) -> str:
    tag = tag.strip().removeprefix("W/").strip('"')
    for suffix in _ENCODING_SUFFIXES:
        tag = tag.removesuffix(suffix)
    return tag


def conditional_json(request: Request, payload: Any, cache_control: str) -> Response:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    tag = hashlib.sha256(body).hexdigest()[:32]
    headers = {"ETag": f'"{tag}"', "Cache-Control": cache_control}
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match.strip() == "*" or tag in {_opaque(t) for t in if_none_match.split(",")}:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(body, media_type="application/json", headers=headers)
