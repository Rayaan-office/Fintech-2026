"""Tamper-evident activity log.

Each entry stores an HMAC of its own content plus the previous entry's hash, so editing
or deleting any entry breaks the chain. Entries never hold document text: only IDs,
placeholders, amounts and fingerprints.
"""

import hashlib
import hmac
import json
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AuditEntry

GENESIS = "0" * 64
_FORBIDDEN_KEYS = {"text", "content", "body", "raw", "password", "token", "secret", "ocr"}
_MAX_STR = 300


def _clean(value, depth: int = 0):
    if depth > 4:
        return "…"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if str(k).lower() in _FORBIDDEN_KEYS:
                raise ValueError(f"audit details may not contain '{k}'")
            out[str(k)] = _clean(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_clean(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, str):
        return value[:_MAX_STR]
    if isinstance(value, (UUID, datetime)):
        return str(value)
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)[:_MAX_STR]


def _digest(prev_hash: str, business_id: str, at: str, actor: str, event: str, subject, details) -> str:
    payload = json.dumps(
        [prev_hash, business_id, at, actor, event, subject, details], sort_keys=True, separators=(",", ":")
    )
    key = get_settings().audit_log_hmac_key.get_secret_value().encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def record(db: Session, business_id: UUID | str, actor: str, event: str,
           subject: str | None = None, details: dict | None = None) -> AuditEntry:
    """Append one entry. Must be called inside a tenant transaction."""
    bid = str(business_id)
    # One writer at a time per business keeps the chain linear
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"audit:{bid}"})
    last = db.execute(
        select(AuditEntry.hash).where(AuditEntry.business_id == business_id)
        .order_by(AuditEntry.seq.desc()).limit(1)
    ).scalar()
    prev = last or GENESIS
    at = datetime.now(UTC)
    clean = _clean(details or {})
    entry = AuditEntry(
        business_id=business_id, at=at, actor=actor, event=event, subject=subject, details=clean,
        prev_hash=prev, hash=_digest(prev, bid, at.isoformat(), actor, event, subject, clean),
    )
    db.add(entry)
    db.flush()
    return entry


def verify_chain(db: Session, business_id: UUID | str) -> dict:
    """Recompute every hash. Returns {"intact": bool, "entries": n, "broken_at": seq | None}."""
    prev = GENESIS
    n = 0
    rows = db.execute(
        select(AuditEntry).where(AuditEntry.business_id == business_id).order_by(AuditEntry.seq)
    ).scalars()
    for e in rows:
        n += 1
        expected = _digest(prev, str(e.business_id), e.at.astimezone(UTC).isoformat(), e.actor, e.event,
                           e.subject, e.details)
        if e.prev_hash != prev or e.hash != expected:
            return {"intact": False, "entries": n, "broken_at": e.seq}
        prev = e.hash
    return {"intact": True, "entries": n, "broken_at": None}
