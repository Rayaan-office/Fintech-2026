"""Suppliers and customers: finding them by name, and keeping every version of their details."""

import re

from rapidfuzz import fuzz, process
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Counterparty, CounterpartyVersion

_SUFFIX = re.compile(r"\b(ltd|limited|plc|llp|llc|inc|co|company|uk|group|the)\b\.?", re.I)

# Detail fields we track for changes, and their placeholder kinds
TRACKED = {
    "bank_account": "BANK_ACCOUNT",
    "sort_code": "SORT_CODE",
    "email": "EMAIL",
    "phone": "PHONE",
    "address": "ADDRESS",
}
BANK_FIELDS = {"bank_account", "sort_code"}


def normalize(name: str) -> str:
    n = _SUFFIX.sub(" ", name.lower())
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    return " ".join(n.split())


def find_or_create(db: Session, business_id, kind: str, name: str, email_domain: str | None = None,
                   create: bool = True) -> tuple[Counterparty | None, bool]:
    """Returns (counterparty, is_new). Matches on a cleaned-up name (e.g. 'Acme Supplies Ltd' = 'ACME Supplies')."""
    norm = normalize(name)
    if not norm:
        return None, False
    rows = db.execute(select(Counterparty).where(Counterparty.kind == kind)).scalars().all()
    exact = next((c for c in rows if c.normalized_name == norm), None)
    if exact:
        return exact, False
    if rows:
        best = process.extractOne(norm, {c.id: c.normalized_name for c in rows}, scorer=fuzz.token_sort_ratio)
        if best and best[1] >= 92:
            return next(c for c in rows if c.id == best[2]), False
    if not create:
        return None, False
    cp = Counterparty(business_id=business_id, kind=kind, display_name=name.strip()[:300], normalized_name=norm,
                      email_domain=email_domain)
    db.add(cp)
    db.flush()
    return cp, True


def latest_details(db: Session, counterparty_id) -> dict:
    """The most recent known value (fingerprint, vault id, masked) for each tracked field."""
    versions = db.execute(
        select(CounterpartyVersion).where(CounterpartyVersion.counterparty_id == counterparty_id)
        .order_by(CounterpartyVersion.seen_at)
    ).scalars().all()
    merged: dict = {}
    for v in versions:
        merged.update({k: dict(val, seen_at=v.seen_at.isoformat(), document_id=str(v.source_document_id or ""))
                       for k, val in v.details.items()})
    return merged


def compare(previous: dict, new: dict) -> list[dict]:
    """Fields whose value differs from the one on record."""
    changes = []
    for field, val in new.items():
        old = previous.get(field)
        if old and old.get("fp") != val.get("fp"):
            changes.append({"field": field, "before": old.get("display"), "after": val.get("display"),
                            "before_seen": old.get("seen_at"), "bank": field in BANK_FIELDS})
    return changes


def add_version(db: Session, business_id, counterparty_id, details: dict, source: str, document_id=None) -> None:
    if details:
        db.add(CounterpartyVersion(business_id=business_id, counterparty_id=counterparty_id, details=details,
                                   source=source, source_document_id=document_id))
