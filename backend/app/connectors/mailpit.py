"""Email inbox, demo version: the Mailpit test inbox.

Mailpit's notification only tells us a message ID. We then read the message from Mailpit
ourselves, find which business's bills inbox it was sent to, and hand the raw email to
email_in, which works the same for any inbox.
"""

from urllib.parse import quote

from ..config import get_settings
from ..db import global_session
from . import email_in, outbound
from .common import lookup_route

_s = get_settings()
API = _s.mailpit_api_url.rstrip("/") + "/api/v1"


def _get(path: str, raw: bool = False):
    with outbound.client(timeout=15) as http:
        r = http.get(f"{API}{path}")
    r.raise_for_status()
    return r.content if raw else r.json()


def _routes(summary: dict) -> dict:
    """business_id -> the bills inbox address this email was sent to (To, Cc or Bcc)."""
    out: dict = {}
    with global_session() as db:
        for a in (summary.get("To") or []) + (summary.get("Cc") or []) + (summary.get("Bcc") or []):
            addr = (a.get("Address") or "").strip().lower()
            bid = lookup_route(db, "email", addr) if addr else None
            if bid and bid not in out:
                out[bid] = addr
    return out


def handle_new_message(message_id: str) -> list[email_in.Outcome]:
    """Called when Mailpit says a message arrived."""
    summary = _get(f"/message/{message_id}")
    routes = _routes(summary)
    if not routes:
        return []  # not sent to a connected bills inbox
    raw = _get(f"/message/{message_id}/raw", raw=True)
    return [email_in.process(bid, raw, inbox) for bid, inbox in routes.items()]


def sync(db, business_id) -> dict:
    """Catch up on emails that arrived while our app wasn't listening. Each is still processed once."""
    from .common import get_connection

    inbox = ((get_connection(db, business_id, "mailpit").meta or {}).get("address") or "").lower()
    if not inbox:
        return {"emails": 0}
    found = _get("/search?limit=200&query=" + quote(f'to:"{inbox}"'))
    counts: dict[str, int] = {"emails": 0}
    for m in found.get("messages") or []:
        raw = _get(f"/message/{m['ID']}/raw", raw=True)
        outcome = email_in.process(business_id, raw, inbox)
        counts["emails"] += 1
        counts[outcome.status] = counts.get(outcome.status, 0) + 1
    return counts
