"""Browser security headers, same-origin checks for changes, and simple rate limits."""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from ..config import get_settings

_s = get_settings()

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
    "media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# Signed by the sender instead of a browser session
ORIGIN_EXEMPT_PREFIXES = ("/webhooks/", "/connect/quickbooks/callback", "/api/handoff/upload")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Changes must come from our own app's address (blocks cross-site request forgery)
        if request.method not in SAFE_METHODS and not request.url.path.startswith(ORIGIN_EXEMPT_PREFIXES):
            origin = request.headers.get("origin") or request.headers.get("referer", "")
            allowed = (_s.app_base_url.rstrip("/"), _s.api_base_url.rstrip("/"))
            # The whole address must match: a look-alike such as localhost:5173.evil.com is refused
            if not any(origin == a or origin.startswith(a + "/") for a in allowed):
                return JSONResponse({"detail": "Request refused: unknown origin."}, status_code=403)
        response = await call_next(request)
        h = response.headers
        h.setdefault("Content-Security-Policy", CSP)
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        if _s.app_base_url.startswith("https:"):
            h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if request.url.path.startswith("/api/"):
            h.setdefault("Cache-Control", "no-store")
        return response


class RateLimiter:
    """Sliding-window limit kept in memory (one server process in our demo)."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.monotonic()
        q = self._hits[key]
        while q and q[0] <= now - window_seconds:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, "Too many requests. Please wait a moment and try again.")
        q.append(now)

    def reset(self) -> None:
        self._hits.clear()


limiter = RateLimiter()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def csv_safe(value) -> str:
    """Neutralise spreadsheet formulas in exported cells."""
    s = "" if value is None else str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s
