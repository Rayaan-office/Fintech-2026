"""Fraud warnings. Any warning stops automatic processing and sends the item to a person."""

import re
import statistics

from rapidfuzz.distance import Levenshtein
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Counterparty, Document, Record

PRESSURE = re.compile(
    r"(?i)\b(urgent(ly)?|immediately|right away|asap|within 24 hours|today only|final (notice|demand)|"
    r"overdue.{0,20}(legal|court)|new bank (details|account)|changed? (our|the) bank|updated? (bank|payment) details|"
    r"wire (it )?today|gift cards?|confidential(ly)?|do not (call|contact)|keep this between)\b"
)

LABELS = {
    "bank_details_changed": "Changed bank details",
    "duplicate": "Duplicate invoice",
    "lookalike_sender": "Look-alike sender",
    "sender_checks_failed": "Failed sender checks",
    "unusual_amount": "Unusual amount",
    "pressure_tactics": "Pressure tactics",
}


def _w(kind: str, detail: str, **extra) -> dict:
    return {"kind": kind, "label": LABELS[kind], "detail": detail, **extra}


def check(db: Session, *, document: Document, counterparty: Counterparty | None, is_new_counterparty: bool,
          reference: str, total_minor: int | None, changes: list[dict], redacted_text: str,
          contact_domain: str | None = None) -> list[dict]:
    warnings: list[dict] = []

    # Changed bank details
    bank_changes = [c for c in changes if c["bank"]]
    if bank_changes:
        warnings.append(_w("bank_details_changed",
                           "The bank details on this bill differ from the ones on record.", changes=bank_changes))

    # Duplicate: same file, or same supplier + number + amount
    same_file = db.execute(
        select(Document.id).where(Document.sha256 == document.sha256, Document.id != document.id,
                                  Document.status != "rejected")
    ).first()
    if same_file:
        warnings.append(_w("duplicate", "This exact file was received before.", other_document=str(same_file[0])))
    elif counterparty and reference and total_minor is not None:
        dup = db.execute(
            select(Record.id).where(Record.counterparty_id == counterparty.id, Record.reference == reference,
                                    Record.amount_minor == total_minor, Record.status != "void")
        ).first()
        if dup:
            warnings.append(_w("duplicate", f"A bill with number {reference} and the same amount is already recorded.",
                               other_record=str(dup[0])))
        else:
            waiting = db.execute(select(Document.id).where(
                Document.counterparty_id == counterparty.id, Document.id != document.id,
                Document.fields["reference"].astext == reference, Document.fields["total"].astext == f"{total_minor / 100:.2f}",
                Document.status.in_(("awaiting_approval", "review", "approved")))).first()
            if waiting:
                warnings.append(_w("duplicate", f"Bill {reference} for the same amount was already received.",
                                   other_document=str(waiting[0])))

    # Look-alike domain (one or two letters away from a known supplier's), from the sender or on the bill
    known = db.execute(select(Counterparty.email_domain, Counterparty.display_name)
                       .where(Counterparty.email_domain.is_not(None))).all()
    for where, dom_seen in (("sender", document.sender_domain), ("email address on the bill", contact_domain)):
        seen = (dom_seen or "").lower()
        hit = next(((d, n) for d, n in known if d and d != seen and len(seen) > 5
                    and Levenshtein.distance(d, seen) <= 2), None)
        if hit:
            warnings.append(_w("lookalike_sender", f"The {where} {seen} looks like {hit[1]}'s address {hit[0]}.",
                               seen=seen, similar_to=hit[0]))
            break

    # Failed sender checks
    checks = document.sender_checks or {}
    failed = [k.upper() for k in ("spf", "dkim", "dmarc") if checks.get(k) in ("fail", "softfail", "permerror")]
    if failed:
        warnings.append(_w("sender_checks_failed", "The email failed the standard sender checks: " + ", ".join(failed) + ".",
                           failed=failed))

    # Unusual amount: far above this supplier's usual range
    if counterparty and total_minor:
        past = db.execute(select(Record.amount_minor).where(
            Record.counterparty_id == counterparty.id, Record.kind == "bill", Record.status != "void")).scalars().all()
        if len(past) >= 3:
            median = statistics.median(past)
            if total_minor > 3 * median and total_minor - median > 20_000:
                warnings.append(_w("unusual_amount",
                                   f"£{total_minor / 100:,.2f} is far above this supplier's usual £{median / 100:,.2f}.",
                                   usual_minor=int(median)))

    # Pressure tactics from a new supplier
    if is_new_counterparty and PRESSURE.search(redacted_text or ""):
        phrase = PRESSURE.search(redacted_text).group(0)
        warnings.append(_w("pressure_tactics", f"A new supplier is using urgent payment language (“{phrase}”).",
                           phrase=phrase))
    return warnings
