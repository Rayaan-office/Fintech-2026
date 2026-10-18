"""Payment reminders in three steps (analytics/getting_paid.py finds when each is due).

Drafting: each step's email is worded by the AI from the facts (fact-checked), with our own
template as the fallback, and waits for approval. A final notice needs a business owner.
Sending, only once approved: we check the invoices are still unpaid, make a card payment link
for each (never before approval), add the links to the email and record the step.
"""

from uuid import UUID

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..analytics import getting_paid, ledger
from ..connectors import outbound, payment_links
from ..connectors.stripe_conn import StripeError
from ..models import Counterparty, Recommendation, Record, Reminder
from . import insights
from .wording import day, money

SUBJECTS = {1: "Payment reminder from {biz}", 2: "Second reminder: unpaid invoices from {biz}",
            3: "Final notice: unpaid invoices from {biz}"}


def _still_owed(db: Session, ids: list) -> list[Record]:
    """The invoices still unpaid, in the order given (never what is left after a payment arrived short)."""
    home, foreign = ledger.open_items(db, "invoice")
    open_ids = {r.id: r for r in home + foreign}
    return [open_ids[UUID(str(i))] for i in ids if UUID(str(i)) in open_ids]


def facts_and_body(db: Session, stage: int, records: list[Record]) -> tuple[dict, str]:
    """The facts the AI words the email from, and our own wording of it."""
    terms = ledger.terms(db)
    done = getting_paid.sent(db, [r.id for r in records])
    earlier = sorted({(s, d) for r in records for s, d in done.get(r.id, {}).items()})
    facts = {"reminder": f"{stage} of {getting_paid.LAST_STAGE} ({getting_paid.STAGES[stage]})",
             "overdue invoices": [f"{r.reference or 'invoice'}: {money(r.open_minor)}, due "
                                  f"{day(ledger.due(r, terms))}" for r in records[:8]],
             "total overdue": money(sum(r.open_minor for r in records))}
    if earlier:
        facts["earlier reminders"] = [f"reminder {s} sent on {day(d)}" for s, d in earlier]
    lines = "\n".join(f"- {x}" for x in facts["overdue invoices"])
    dates = " and ".join(day(d) for _, d in earlier)
    if stage == 1:
        body = (f"Our records show these invoices are now overdue:\n{lines}\n\nCould you let us know when we can "
                "expect payment? If you have already paid, thank you, and please ignore this reminder.")
    elif stage == 2:
        body = (f"We wrote to you on {dates or 'an earlier date'} about these invoices, which are still unpaid:\n"
                f"{lines}\n\nPlease arrange payment now, or let us know if something is holding it up.")
    else:
        body = (f"This is our final reminder about these invoices, still unpaid after our reminders of "
                f"{dates or 'earlier dates'}:\n{lines}\n\nPlease pay them now. If there is a reason you can't, "
                "please contact us straight away so we can agree a plan.")
    return facts, body


def draft(db: Session, rec: Recommendation, cp: Counterparty) -> "insights.Draft":
    """The email for a chase_overdue recommendation, for a person to check and approve."""
    step = rec.next_step or {}
    stage = int(step.get("stage") or 1)
    records = _still_owed(db, step.get("record_ids") or [])
    if not records:
        raise HTTPException(409, "These invoices have been paid since, so there is nothing to chase.")
    facts, body = facts_and_body(db, stage, records)
    biz = ledger.business(db)
    d = insights.draft(db, rec.business_id, "send_payment_reminder", cp, getting_paid.PURPOSE[stage], facts, body,
                       subject=SUBJECTS[stage].format(biz=biz.name))
    d.extra_payload = {"stage": stage, "record_ids": [str(r.id) for r in records]}
    if any(r.source == "stripe" and payment_links.safe_url((r.external or {}).get("hosted_invoice_url"))
           for r in records) or payment_links.configured():
        d.extra_effects = ["Once approved, add a link to pay each invoice online by card (made only then)"]
    else:
        d.extra_effects = ["No card payment link: payment links aren't set up yet"]
    if stage == getting_paid.LAST_STAGE:
        d.extra_reasons = ["This is a final notice: a business owner must approve it."]
    return d


def before_send(db: Session, action) -> tuple[str, list[tuple[Record, str | None]]]:
    """The email body with payment links, and the invoices it chases. Runs only for an approved
    reminder, just before it is sent. Raises if there is nothing left to chase."""
    p = action.payload
    stage = int(p["stage"])
    records = _still_owed(db, p.get("record_ids") or [])
    done = getting_paid.sent(db, [r.id for r in records])
    records = [r for r in records if stage not in done.get(r.id, {})]
    if not records:
        raise HTTPException(409, "These invoices are paid, or were already sent this reminder.")
    links = []
    for r in records:
        try:
            links.append((r, payment_links.for_invoice(db, r)))
        except (StripeError, outbound.OutboundRefused, httpx.HTTPError):
            raise HTTPException(502, "We couldn't make the card payment link just now. Nothing was sent; "
                                     "approve again in a minute.") from None
    body = p["body"]
    with_link = [(r, url) for r, url in links if url]
    if with_link:
        body += "\n\nYou can pay online by card:\n" + "\n".join(
            f"- {r.reference or 'Invoice'} ({money(r.open_minor)}): {url}" for r, url in with_link)
    return body, links


def after_send(db: Session, action, links: list[tuple[Record, str | None]]) -> dict:
    """Record the step for each invoice the email chased."""
    stage = int(action.payload["stage"])
    for r, url in links:
        db.add(Reminder(business_id=action.business_id, record_id=r.id, stage=stage, action_id=action.id,
                        link_url=url, link_minor=r.open_minor if url else None))
    db.flush()
    return {"stage": stage, "invoices": len(links), "links": sum(1 for _, url in links if url)}
