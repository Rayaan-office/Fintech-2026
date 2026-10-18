"""What each approved action actually does. Registered with actions.handler()."""

from datetime import UTC, date, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import actions, archive, events
from .analytics import ledger, matching
from .connectors import quickbooks
from .connectors.common import upsert_record
from .copilot import reminders
from .models import Action, Business, Connection, Counterparty, Document, Match, Recommendation, Record
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
        lines=[{"description": li.get("description"), "amount_minor": extract.to_minor(li.get("amount")),
                "quantity": li.get("quantity") or None, "unit_price_minor": extract.to_minor(li.get("unit_price"))}
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
    if _accounting_connected(db) and kind == "bill":
        actions.propose(db, doc.business_id, "post_to_accounting", requested_by="ai:ingestion",
                        payload={"record_id": str(rec.id), "document_id": str(doc.id)},
                        summary=f"Add {f.get('counterparty_name')} bill of £{total / 100:,.2f} to QuickBooks, "
                                "with the original attached",
                        effects=["Create the bill in QuickBooks", "Attach the original document"],
                        amount_minor=total)
    events.publish(doc.business_id, "document", {"id": str(doc.id), "status": "approved"})
    from .copilot import insights  # new data: check for recommendations once this is saved

    insights.refresh_after_commit(db, doc.business_id)
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


# ── Accounting software ────────────────────────────────────────────────────


def _post_to_accounting(db: Session, action: Action, actor: str) -> dict:
    """Add the approved bill to QuickBooks with the original attached. If QuickBooks can't be
    reached, the approval isn't used up: the person sees why and can approve again, and QuickBooks
    recognises the repeat (same request id) instead of making a second bill."""
    p = action.payload
    rec = db.get(Record, UUID(p["record_id"]))
    doc = db.get(Document, UUID(p["document_id"]))
    if not rec or not doc or rec.status == "void" or doc.record_id != rec.id:
        raise actions.HTTPException(409, "This bill was undone or changed, so it can't be added to QuickBooks.")
    if rec.kind != "bill":
        raise actions.HTTPException(409, "Only bills can be added to the accounting software.")
    original = archive.get(doc.object_key, doc.sha256)
    try:
        return quickbooks.post_bill(db, action.business_id, rec, original, doc.filename, doc.mime,
                                    request_key=str(action.id))
    except quickbooks.QBOError as exc:
        if exc.code in ("NO_SUPPLIER", "CURRENCY", "NO_TAX_CODE", "NO_EXPENSE_ACCOUNT"):
            raise  # nothing a retry would fix: the action is marked failed with the reason
        raise actions.HTTPException(409 if exc.expired or exc.code == "NOT_CONNECTED" else 502,
                                    exc.for_person()) from None


actions.handler("post_to_accounting")(_post_to_accounting)


# ── Emails ─────────────────────────────────────────────────────────────────

EMAIL_TO = {"send_payment_reminder": "customer", "email_supplier": "supplier"}


def _send_email(db: Session, action: Action, actor: str) -> dict:
    """Payload: counterparty_id, subject, body. The address is the one on record (last approved),
    so a bill with changed contact details can't redirect our questions to a fraudster."""
    from .connectors import email_out
    from .privacy.redact import vault_values

    p = action.payload
    cp = db.get(Counterparty, UUID(p["counterparty_id"]))
    if not cp or cp.kind != EMAIL_TO[action.type]:
        raise actions.HTTPException(409, "This email isn't addressed to the right kind of contact.")
    # Checking changed details: write to the address on record before the change
    until = datetime.fromisoformat(p["contact_as_of"]) if p.get("contact_as_of") else None
    contact = counterparties.latest_details(db, cp.id, until=until).get("email") or {}
    to = vault_values(action.business_id, [contact["vault"]]).get(contact["vault"]) if contact.get("vault") else None
    if not to:
        raise actions.HTTPException(409, f"We don't have an email address on record for {cp.display_name}.")
    conn = db.execute(select(Connection).where(Connection.kind == "email")).scalar_one_or_none()
    inbox = (conn.meta or {}).get("address") if conn else None
    if not inbox:
        raise actions.HTTPException(409, "Connect the email inbox first.")
    biz = db.get(Business, action.business_id)
    body, links = p["body"], None
    if action.type == "send_payment_reminder" and p.get("stage"):
        body, links = reminders.before_send(db, action)  # payment links are made now, never before approval
    try:
        message_id = email_out.send(to, p["subject"], body, from_address=inbox, from_name=biz.name)  # last step
    except email_out.SendRefused as e:
        raise actions.HTTPException(409, str(e))
    staged = reminders.after_send(db, action, links) if links is not None else {}
    events.publish(action.business_id, "email_sent", {"action_id": str(action.id)})
    if p.get("recommendation_id"):
        rec = db.get(Recommendation, UUID(p["recommendation_id"]))
        if rec and rec.status == "new":
            rec.status = "done"
    return {"sent_to": contact.get("display"), "message_id": message_id, **staged}


for _type in EMAIL_TO:
    actions.handler(_type)(_send_email)


def _share_lender_pack(db: Session, action: Action, actor: str) -> dict:
    """Email the lender pack exactly as the approver saw it (stored when it was prepared)."""
    from .connectors import email_out

    p = action.payload
    pdf = archive.get(p["object_key"], p["sha256"])
    conn = db.execute(select(Connection).where(Connection.kind == "email")).scalar_one_or_none()
    inbox = (conn.meta or {}).get("address") if conn else None
    if not inbox:
        raise actions.HTTPException(409, "Connect the email inbox first.")
    biz = db.get(Business, action.business_id)
    body = (f"Hello {p.get('lender_name') or ''},\n\nPlease find attached the lender pack for {biz.name}: our business "
            "profile, profit and loss for the last 12 months, unpaid invoices and our cash forecast, prepared from "
            f"our records on {p['prepared_on']}.\n\nKind regards,\n{biz.name}").replace("Hello ,", "Hello,")
    try:
        message_id = email_out.send(p["email"], f"Lender pack: {biz.name}", body, from_address=inbox,
                                    from_name=biz.name, attachments=[(p["filename"], "application/pdf", pdf)])
    except email_out.SendRefused as e:
        raise actions.HTTPException(409, str(e))
    return {"sent_to": p["email"], "message_id": message_id}


actions.handler("share_lender_pack")(_share_lender_pack)


# ── Matching ───────────────────────────────────────────────────────────────


def run_matching(db: Session, business_id, actor: str = "ai:matching") -> dict:
    """Find matches; confident small ones are accepted automatically, the rest wait for a person.
    Suggestions that no longer hold (the item was paid elsewhere, the payment was voided) are withdrawn."""
    withdrawn = _withdraw_stale(db, business_id)
    linked = 0
    for c in matching.already_settled(db):  # same money seen twice; nothing changes, so no approval
        matching.apply(db, c, "accepted", actor)
        linked += 1
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
    if found or withdrawn:
        events.publish(business_id, "matches", {"auto": auto, "suggested": suggested, "withdrawn": withdrawn})
    if linked or withdrawn:
        audit.record(db, business_id, actor, "matches_tidied", details={"linked": linked, "withdrawn": withdrawn})
    return {"auto": auto, "suggested": suggested, "linked": linked, "withdrawn": withdrawn}


def _withdraw_stale(db: Session, business_id) -> int:
    n = 0
    for m in db.execute(select(Match).where(Match.status == "suggested")).scalars().all():
        if matching.still_suggested(db, m):
            continue
        m.status = "withdrawn"
        for a in db.execute(select(Action).where(Action.type == "accept_match", Action.status == "pending",
                                                 Action.payload["match_id"].astext == str(m.id))).scalars():
            a.status = "cancelled"
            a.decided_at = datetime.now(UTC)
            a.result = {"reason": "This suggestion no longer fits the records."}
            audit.record(db, business_id, "ai:matching", "action_cancelled", subject=f"action:{a.id}",
                         details={"type": a.type, "reason": "stale_match"})
            events.publish(business_id, "action", {"id": str(a.id), "status": "cancelled", "type": a.type})
        n += 1
    return n


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
    target = db.get(Record, m.left_id)
    if m.status == "suggested" and (target.status in ("paid", "void") or not matching.still_suggested(db, m)):
        raise actions.HTTPException(409, "This match no longer fits the records: the item was paid or changed "
                                         "since it was suggested.")
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


# ── Getting paid ───────────────────────────────────────────────────────────


def _record_bank_charge(db: Session, action: Action, actor: str) -> dict:
    """Close what is left on invoices whose payment arrived short: a bank charge (a cost of ours),
    recorded on the day the payment arrived, and the invoice is paid from that day."""
    short = ledger.short_paid(db)
    done = []
    for rid in action.payload["record_ids"]:
        x = short.get(UUID(rid))
        if not x or x.record.status != "open" or x.record.open_minor <= 0:
            continue
        inv = x.record
        fee, _ = upsert_record(
            db, action.business_id, "manual", f"bank_charge:{inv.id}", kind="fee", direction="out",
            amount_minor=inv.open_minor, open_minor=0, currency=inv.currency, date=x.paid_on, status="posted",
            counterparty_id=inv.counterparty_id, reference=inv.reference, category="bank_charges",
            description=f"Bank charge: payment for {inv.reference or 'an invoice'} arrived short"[:500],
            external={"invoice": str(inv.id), "action": str(action.id)})
        done.append({"invoice_id": str(inv.id), "fee_id": str(fee.id), "amount_minor": inv.open_minor})
        matching.settle(db, inv, inv.open_minor, x.paid_on)
    if not done:
        raise actions.HTTPException(409, "There is nothing short left to record on these invoices.")
    if action.payload.get("recommendation_id"):
        rec = db.get(Recommendation, UUID(action.payload["recommendation_id"]))
        if rec and rec.status == "new":
            rec.status = "done"
    from .copilot import insights  # the invoices are paid now: check the recommendations again

    insights.refresh_after_commit(db, action.business_id)
    return {"charges": done, "amount_minor": sum(d["amount_minor"] for d in done)}


def _undo_bank_charge(db: Session, action: Action, actor: str) -> dict:
    for d in (action.result or {}).get("charges", []):
        db.get(Record, UUID(d["fee_id"])).status = "void"
        inv = db.get(Record, UUID(d["invoice_id"]))
        inv.open_minor = min(inv.amount_minor, (inv.open_minor or 0) + d["amount_minor"])
        inv.status = "open"
        inv.paid_date = None
    return {}


actions.handler("record_bank_charge", undo=_undo_bank_charge)(_record_bank_charge)
