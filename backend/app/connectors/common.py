"""Helpers shared by the connectors: connection rows, encrypted tokens, upserting ledger records."""

import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import events
from ..models import Connection, ConnectionRoute, ProcessedEvent, Record
from ..security.crypto import tokens

KINDS = {"stripe": "payments", "plaid": "bank", "quickbooks": "accounting", "mailpit": "email"}


def get_connection(db: Session, business_id, provider: str, create: bool = True) -> Connection | None:
    kind = KINDS[provider]
    c = db.execute(select(Connection).where(Connection.kind == kind)).scalar_one_or_none()
    if not c and create:
        c = Connection(business_id=business_id, kind=kind, provider=provider, status="disconnected", meta={})
        db.add(c)
        db.flush()
    return c


def save_secret(c: Connection, secret: dict) -> None:
    c.token_enc = tokens.seal_str(json.dumps(secret))


def load_secret(c: Connection) -> dict:
    return json.loads(tokens.open_str(c.token_enc)) if c.token_enc else {}


def mark_synced(db: Session, c: Connection, counts: dict) -> None:
    c.status = "connected"
    c.last_sync_at = datetime.now(UTC)
    c.last_error = None
    c.meta = {**(c.meta or {}), "last_counts": counts}
    events.publish(c.business_id, "connection", {"provider": c.provider, "status": c.status, "counts": counts})


def mark_error(db: Session, c: Connection, message: str, expired: bool = False) -> None:
    c.status = "expired" if expired else "error"
    c.last_error = message[:300]
    events.publish(c.business_id, "connection", {"provider": c.provider, "status": c.status})


def route(db: Session, kind: str, external_id: str, business_id) -> None:
    """Remember which business an outside account belongs to (for incoming notifications)."""
    r = db.execute(select(ConnectionRoute).where(ConnectionRoute.kind == kind,
                                                 ConnectionRoute.external_id == external_id)).scalar_one_or_none()
    if r and r.business_id != business_id:
        raise PermissionError("this outside account is already connected to another business")
    if not r:
        db.add(ConnectionRoute(kind=kind, external_id=external_id, business_id=business_id))


def lookup_route(db: Session, kind: str, external_id: str):
    r = db.execute(select(ConnectionRoute).where(ConnectionRoute.kind == kind,
                                                 ConnectionRoute.external_id == external_id)).scalar_one_or_none()
    return r.business_id if r else None


def seen_before(db: Session, business_id, source: str, event_id: str) -> bool:
    """True if this notification or email was already handled; otherwise records it."""
    if db.execute(select(ProcessedEvent.id).where(ProcessedEvent.source == source,
                                                  ProcessedEvent.event_id == event_id)).first():
        return True
    db.add(ProcessedEvent(business_id=business_id, source=source, event_id=event_id[:500]))
    db.flush()
    return False


def upsert_record(db: Session, business_id, source: str, source_ref: str, **values) -> tuple[Record, bool]:
    """Insert or update one ledger record from an outside system. Returns (record, created)."""
    r = db.execute(select(Record).where(Record.source == source, Record.source_ref == source_ref)).scalar_one_or_none()
    created = r is None
    if created:
        r = Record(business_id=business_id, source=source, source_ref=source_ref, **values)
        db.add(r)
    else:
        # Don't overwrite what our matching has settled
        keep_open = r.open_minor if r.kind in ("invoice", "bill") and values.get("status") == "open" else None
        for k, v in values.items():
            setattr(r, k, v)
        if keep_open is not None:
            r.open_minor = min(keep_open, values.get("open_minor", keep_open))
    db.flush()
    return r, created
