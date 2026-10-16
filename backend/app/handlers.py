"""What each approved action actually does. Registered with actions.handler()."""

from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import actions, events
from .analytics import matching
from .models import Action, Connection, Counterparty, Document, Match, Record
from .pipeline import counterparties, extract
from .security import audit

DOC_KIND = {
    # doc_type -> (record kind, direction, open?)
    "bill": ("bill", "out", True),
    "invoice": ("invoice", "in", True),
    "receipt": ("payment_out", "out", False),
    "credit_note": ("credit_note", "in", False),
    "payment_notice": ("payment_in", "in", False),
}


# ── Documents ──────────────────────────────────────────────────────────────


def _approve_document(db: Session, action: Action, actor: str) -> dict:
    p = action.payload
    bank_id = p.get("bank_change_action_id")
    if bank_id:
        bank = db.get(Action, UUID(bank_id))
        if not bank or bank.status != "executed":
            raise actions.HTTPException(409, "Approve the bank-detail change (two people) before recording this bill.")
    doc = db.get(Document, UUID(p["document_id"]))
    f = doc.fields or {}
    kind, direction, is_open = DOC_KIND.get(doc.doc_type or "bill", ("bill", "out", True))
    total = extract.to_minor(f.get("total")) or 0
    issue = extract.to_date(f.get("issue_date")) or date.today()
    due = extract.to_date(f.get("due_date"))
    cp = db.get(Counterparty, UUID(p["counterparty_id"])) if p.get("counterparty_id") else None
    rec = Record(
        business_id=doc.business_id, source="document", source_ref=str(doc.id), kind=kind, direction=direction,
        amount_minor=total, open_minor=total if is_open else 0, currency=(f.get("currency") or "GBP").upper(),
        date=issue, due_date=due, status="open" if is_open else "posted", counterparty_id=cp.id if cp else None,
        reference=f.get("reference") or None, description=(f.get("counterparty_name") or "")[:500],
        category=(f.get("category_hint") or (cp.category if cp else None) or None),
        document_id=doc.id, tax_minor=extract.to_minor(f.get("tax")),
        lines=[{"description": li.get("description"), "amount_minor": extract.to_minor(li.get("amount"))}
               for li in f.get("line_items", [])][:200],
    )
    if cp and not cp.category and rec.category:
        cp.category = rec.category
    db.add(rec)
    db.flush()
    if cp and not bank_id:
        counterparties.add_version(db, doc.business_id, cp.id, p.get("details") or {}, "document", doc.id)
    doc.record_id = rec.id
    doc.status = "approved"
    run_matching(db, doc.business_id, actor)
    if _accounting_connected(db) and kind in ("bill", "invoice"):
        actions.propose(db, doc.business_id, "post_to_accounting", requested_by="ai:ingestion",
                        payload={"record_id": str(rec.id), "document_id": str(doc.id)},
                        summary=f"Add {f.get('counterparty_name')} {kind} of £{total / 100:,.2f} to QuickBooks, "
                                "with the original attached",
                        effects=["Create the " + kind + " in QuickBooks", "Attach the original document"],
                        amount_minor=total)
    events.publish(doc.business_id, "document", {"id": str(doc.id), "status": "approved"})
    return {"record_id": str(rec.id)}


def _undo_document(db: Session, action: Action, actor: str) -> dict:
    doc = db.get(Document, UUID(action.payload["document_id"]))
    rec = db.get(Record, doc.record_id) if doc.record_id else None
    if rec:
        for m in db.execute(select(Match).where((Match.left_id == rec.id) | (Match.right_id == rec.id),
                                                Match.status == "accepted")).scalars():
            matching.unsettle(db, m)
        rec.status = "void"
        rec.open_minor = 0
    doc.status = "awaiting_approval"
    doc.record_id = None
    return {}


def _reject_document(db: Session, action: Action, actor: str) -> dict:
    db.get(Document, UUID(action.payload["document_id"])).status = "rejected"
    return {}


actions.handler("approve_document", undo=_undo_document, on_reject=_reject_document)(_approve_document)
actions.handler("record_bill", undo=_undo_document)(_approve_document)


def _change_bank(db: Session, action: Action, actor: str) -> dict:
    p = action.payload
    counterparties.add_version(db, action.business_id, UUID(p["counterparty_id"]), p["details"], "approved_change",
                               UUID(p["document_id"]))
    # The waiting bill can now be approved
    return {"counterparty_id": p["counterparty_id"]}


actions.handler("change_supplier_bank")(_change_bank)


# ── Matching ───────────────────────────────────────────────────────────────


def run_matching(db: Session, business_id, actor: str = "ai:matching") -> dict:
    """Find matches; confident small ones are accepted automatically, the rest wait for a person."""
    found = matching.find_candidates(db)
    auto = suggested = 0
    for c in found:
        m = matching.apply(db, c, "suggested", actor)
        a = actions.propose(
            db, business_id, "accept_match", requested_by="ai:matching",
            payload={"match_id": str(m.id)},
            summary=_match_summary(db, c),
            effects=[f"Mark £{c.amount_minor / 100:,.2f} of the {c.target.kind} as paid"],
            amount_minor=c.amount_minor,
            reasons=[] if c.score >= matching.CONFIDENT else [f"Match score {c.score} of 100: please confirm."],
            auto_ok=c.score >= matching.CONFIDENT,
        )
        if a.status == "executed":
            auto += 1
        else:
            suggested += 1
    if found:
        events.publish(business_id, "matches", {"auto": auto, "suggested": suggested})
    return {"auto": auto, "suggested": suggested}


def _match_summary(db: Session, c: matching.Candidate) -> str:
    name = None
    if c.target.counterparty_id:
        cp = db.get(Counterparty, c.target.counterparty_id)
        name = cp.display_name if cp else None
    what = {"invoice": "invoice", "bill": "bill", "payout": "payout"}[c.target.kind]
    ref = f" {c.target.reference}" if c.target.reference else ""
    return f"Match £{c.amount_minor / 100:,.2f} payment on {c.payment.date:%d %b} to {name or 'the'} {what}{ref}"


def _accept_match(db: Session, action: Action, actor: str) -> dict:
    m = db.get(Match, UUID(action.payload["match_id"]))
    if m.status != "accepted":
        m.status = "accepted"
        m.decided_by = actor
        matching.settle(db, db.get(Record, m.left_id), m.amount_minor, db.get(Record, m.right_id).date)
    return {"match_id": str(m.id)}


def _undo_match(db: Session, action: Action, actor: str) -> dict:
    matching.unsettle(db, db.get(Match, UUID(action.payload["match_id"])))
    return {}


actions.handler("accept_match", undo=_undo_match, on_reject=_undo_match)(_accept_match)


def _accounting_connected(db: Session) -> bool:
    c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one_or_none()
    return bool(c and c.status == "connected")


def record_audit(db: Session, business_id, actor: str, event: str, **details) -> None:
    audit.record(db, business_id, actor, event, details=details)
