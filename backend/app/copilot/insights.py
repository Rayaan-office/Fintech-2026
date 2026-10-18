"""The recommendations agent (docs/ALGORITHMS.md, section 9), as a LangGraph workflow:

    find facts -> rank and remove repeats -> AI words them (fact-checked) -> save

It runs whenever new data arrives and once a day. Our rules find the facts (analytics/rules.py);
the AI only words them, from the facts alone, with names as placeholders. A finding already
shown is not shown again unless it gets worse. Dismissing one mutes that kind for that supplier
or customer, except changed bank details, which are always shown.

The AI call happens outside any database transaction.
"""

import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import TypedDict
from uuid import UUID

from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import events
from ..analytics import ledger, rules
from ..config import get_settings
from ..connectors.common import run_once_at_a_time
from ..db import tenant_session
from ..models import Counterparty, Mute, Recommendation
from ..pipeline import counterparties
from ..security import audit
from . import wording

log = logging.getLogger("copilot.insights")
_s = get_settings()

INSTRUCTIONS = (
    "You write one recommendation for a small business owner from the facts our code found. "
    "The title says what happened in at most 12 words. The body says it in two or three short sentences "
    "with the key figures, then one practical next step. Do not add anything the facts don't say."
)
WORSE_BY = 1.2  # a dismissed or unchanged finding is shown again when it is this much worse


class State(TypedDict, total=False):
    business_id: str
    today: date
    findings: list
    names: object
    paused: bool
    to_write: list  # (finding, existing recommendation id or None)
    written: dict  # fingerprint -> wording.Written
    result: dict


def _find(state: State) -> State:
    with tenant_session(UUID(state["business_id"])) as db:
        found = rules.find_all(db, state.get("today"))
        names = wording.Names(db)
        paused = wording.ai_paused(db, UUID(state["business_id"]))
    return {**state, "findings": found, "names": names, "paused": paused}


def _worse(f: rules.Finding, rec: Recommendation) -> bool:
    before = (rec.facts or {}).get("measure") or 0
    sev = rules.SEVERITY_ORDER[f.severity] > rules.SEVERITY_ORDER.get(rec.severity, 0)
    return sev or (before > 0 and f.measure >= before * WORSE_BY) or (
        rec.money_at_stake_minor > 0 and f.money_at_stake_minor >= rec.money_at_stake_minor * WORSE_BY)


def _rank(state: State) -> State:
    """Drop muted kinds, keep what is already shown unless it changed, and resolve what no longer holds."""
    bid = UUID(state["business_id"])
    to_write, resolved, kept = [], 0, 0
    with tenant_session(bid) as db:
        mutes = {(m.kind, m.counterparty_id) for m in db.execute(select(Mute)).scalars()}
        existing = {r.fingerprint: r for r in db.execute(select(Recommendation)).scalars()}
        seen = set()
        for f in state["findings"]:
            seen.add(f.fingerprint)
            rec = existing.get(f.fingerprint)
            if f.mutable and (f.kind, f.counterparty_id) in mutes:
                continue
            if rec is None:
                to_write.append((f, None))
            elif rec.status == "new":
                if (rec.facts or {}).get("facts") != f.facts:
                    to_write.append((f, rec.id))  # the numbers moved: word it again
                else:
                    kept += 1
            elif rec.status in ("resolved", "done") or (rec.status == "dismissed" and _worse(f, rec)):
                to_write.append((f, rec.id))
        for fp, rec in existing.items():
            if fp not in seen and rec.status == "new":
                rec.status = "resolved"
                resolved += 1
    return {**state, "to_write": to_write, "result": {"kept": kept, "resolved": resolved}}


def _anything_new(state: State) -> str:
    return "write" if state["to_write"] else "save"


def _write(state: State) -> State:
    written = {}
    for f, _ in state["to_write"]:
        written[f.fingerprint] = wording.write(
            UUID(state["business_id"]), "recommendation", INSTRUCTIONS, {"kind": f.kind.replace("_", " "), **f.facts},
            state["names"], fallback=(f.title, f.body), paused=state["paused"])
    return {**state, "written": written}


def _save(state: State) -> State:
    bid = UUID(state["business_id"])
    new = updated = 0
    with tenant_session(bid) as db:
        for f, rec_id in state.get("to_write", []):
            w = state["written"][f.fingerprint]
            rec = db.get(Recommendation, rec_id) if rec_id else None
            facts = {"facts": f.facts, "evidence": f.evidence, "why": f.why, "measure": f.measure,
                     "ai_saw": w.ai_saw, "model": w.model, "fact_check": w.problems}
            if rec is None:
                rec = Recommendation(business_id=bid, kind=f.kind, fingerprint=f.fingerprint)
                db.add(rec)
                new += 1
            else:
                updated += 1
            rec.counterparty_id = f.counterparty_id
            rec.severity = f.severity
            rec.money_at_stake_minor = f.money_at_stake_minor
            rec.score = f.score
            rec.facts = facts
            rec.title = w.title[:300]
            rec.body = w.body
            rec.ai_written = w.ai_written
            rec.next_step = f.next_step
            rec.status = "new"
            rec.updated_at = datetime.now(UTC)
        result = {**state["result"], "new": new, "updated": updated}
        if new or updated or result["resolved"]:
            audit.record(db, bid, "ai:recommendations", "recommendations_updated", details=result)
    if new or updated or result["resolved"]:
        events.publish(bid, "recommendations", result)
    return {**state, "result": result}


def _build():
    g = StateGraph(State)
    g.add_node("find_facts", _find)
    g.add_node("rank", _rank)
    g.add_node("write", _write)
    g.add_node("save", _save)
    g.set_entry_point("find_facts")
    g.add_edge("find_facts", "rank")
    g.add_conditional_edges("rank", _anything_new, {"write": "write", "save": "save"})
    g.add_edge("write", "save")
    g.add_edge("save", END)
    return g.compile()


GRAPH = _build()


def run(business_id, today: date | None = None) -> dict:
    """Find, rank, word and save. Returns how many were new, updated, kept and resolved."""
    out = GRAPH.invoke({"business_id": str(business_id), "today": today or date.today()})
    return out["result"]


def refresh_soon(business_id) -> None:
    """Run in the background after new data, one run per business at a time."""
    if _s.app_env == "test":
        return

    def go():
        try:
            run(business_id)
        except Exception:
            log.exception("recommendations run failed")

    threading.Thread(target=lambda: run_once_at_a_time(f"insights:{business_id}", go), daemon=True).start()


def refresh_after_commit(db: Session, business_id) -> None:
    """Run once the current transaction is saved, so the run sees the new data."""
    from sqlalchemy import event

    event.listen(db, "after_commit", lambda _s: refresh_soon(business_id), once=True)


# ── Next steps: a drafted email, which waits for approval ─────────────────


EMAIL_INSTRUCTIONS = (
    "You draft one short, polite business email from a small business to one of its suppliers or customers, "
    "for a person to check before it is sent. Greet the recipient by their placeholder, say what the email is "
    "about using the facts, ask the question, and sign off with the business name given. No threats, no "
    "made-up deadlines."
)


@dataclass
class Draft:
    counterparty: Counterparty
    subject: str
    body: str
    to: str | None  # the address on record, masked
    contact_as_of: str | None
    written: wording.Written
    # Added to the action for a staged reminder (copilot/reminders.py)
    extra_payload: dict = field(default_factory=dict)
    extra_effects: list[str] = field(default_factory=list)
    extra_reasons: list[str] = field(default_factory=list)


def draft(db: Session, business_id, action_type: str, cp: Counterparty, purpose: str, facts: dict,
          fallback_body: str, contact_as_of: str | None = None, subject: str | None = None) -> Draft:
    """An email for a person to check, worded by the AI from the facts (fact-checked), or from our template."""
    biz = ledger.business(db)
    names = wording.Names(db)
    subject = subject or {"email_supplier": f"A question from {biz.name}",
                          "send_payment_reminder": f"Payment reminder from {biz.name}"}[action_type]
    body = f"Hello {cp.display_name},\n\n{fallback_body}\n\nKind regards,\n{biz.name}"
    w = wording.write(business_id, "draft_email", EMAIL_INSTRUCTIONS,
                      {"from business": biz.name, "to": cp.display_name, "what to ask": purpose, **facts}, names,
                      fallback=(subject, body), schema=_EmailAsWording, paused=wording.ai_paused(db, business_id))
    contact = counterparties.latest_details(db, cp.id, until=datetime.fromisoformat(contact_as_of)
                                            if contact_as_of else None)
    return Draft(cp, w.title.replace("\n", " ")[:200], w.body, (contact.get("email") or {}).get("display"),
                 contact_as_of, w)


def _overdue(db: Session, cp: Counterparty) -> list:
    invoices, _ = ledger.open_items(db, "invoice")
    terms = ledger.terms(db)
    return [r for r in invoices if r.counterparty_id == cp.id and ledger.due(r, terms) < date.today()]


def reminder_facts(db: Session, cp: Counterparty) -> tuple[dict, str]:
    terms = ledger.terms(db)
    overdue = _overdue(db, cp)
    facts = {"overdue invoices": [f"{r.reference or 'invoice'}: {wording.money(r.open_minor)}, due "
                                  f"{wording.day(ledger.due(r, terms))}" for r in overdue[:8]],
             "total overdue": wording.money(sum(r.open_minor for r in overdue))}
    lines = "\n".join(f"- {x}" for x in facts["overdue invoices"]) or "- (none)"
    return facts, (f"Our records show these invoices are now overdue:\n{lines}\n\n"
                   "Could you let us know when we can expect payment? If you have already paid, thank you, and "
                   "please ignore this reminder.")


def draft_for_recommendation(db: Session, rec: Recommendation) -> Draft:
    step = rec.next_step or {}
    cp = db.get(Counterparty, rec.counterparty_id) if rec.counterparty_id else None
    if not cp or step.get("action") not in ("email_supplier", "send_payment_reminder"):
        raise LookupError("this recommendation has no email to draft")
    if rec.kind == "chase_overdue":  # a reminder in three steps
        from . import reminders

        return reminders.draft(db, rec, cp)
    facts = dict((rec.facts or {}).get("facts", {}))
    if step["action"] == "send_payment_reminder":
        facts, body = reminder_facts(db, cp)
    elif rec.kind == "price_rise":
        ev = [e for e in (rec.facts or {}).get("evidence", []) if e.get("before")]
        what = "; ".join(f"{e['label']}: {e['before']} before, {e['after']} now" for e in ev)
        body = (f"We noticed a price increase on your recent bills ({what}). Could you tell us about the "
                "increase, and whether the previous price is still available?")
    else:
        changed = facts.get("changed", "details")
        body = (f"We received a bill showing a new {changed} for you. Before we update our records or pay "
                "anything, could you confirm whether these details really changed?")
        facts.pop("changes", None)  # the new details themselves stay out of the email
    return draft(db, rec.business_id, step["action"], cp, step.get("purpose") or "", facts, body,
                 step.get("contact_before"))


class _EmailAsWording(BaseModel):
    """The email in the shape wording.write checks: title is the subject, body is the body."""

    title: str = Field(description="The email subject, one line, at most 80 characters")
    body: str = Field(description="The email, polite and short, signed with the business name")
