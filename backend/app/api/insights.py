"""Cash, forecast, what-if, business health, why cash changed, matches and the Home summary.

Every figure is calculated from our records on request. What-if plans never change real records.
"""

from datetime import date, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events
from ..analytics import forecast, health, ledger
from ..copilot import wording
from ..models import Action, Business, Match, PlannedItem, Recommendation, Record
from ..security import audit
from ..security.rbac import Perm
from .deps import Principal, require, tenant_db

router = APIRouter(prefix="/api", tags=["insights"])

MAX_MINOR = 100_000_000_00  # £100m: anything larger is a typing mistake
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class Plan(BaseModel):
    label: Label
    amount_minor: int = Field(gt=0, le=MAX_MINOR)
    date: date
    repeat: Literal["none", "weekly", "monthly"] = "none"
    direction: Literal["in", "out"] = "out"


class Moved(BaseModel):
    id: Annotated[str, StringConstraints(max_length=80)]
    date: date


class WhatIfIn(BaseModel):
    planned: list[Plan] = Field(default_factory=list, max_length=20)
    excluded_bill_ids: list[Annotated[str, StringConstraints(max_length=80)]] = Field(default_factory=list,
                                                                                   max_length=200)
    moved_bills: list[Moved] = Field(default_factory=list, max_length=200)


class SafetyIn(BaseModel):
    amount_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR)  # None: back to two weeks of spending


def _in_range(d: date) -> date:
    today = date.today()
    if not today - timedelta(days=1) <= d <= today + timedelta(days=366):
        raise HTTPException(422, "Pick a date within the next year.")
    return d


@router.get("/cash")
def cash(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return ledger.cash(db)


@router.get("/cash-flow")
def cash_flow(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return forecast.build(db)


@router.post("/cash-flow/what-if")
def what_if(body: WhatIfIn, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    planned = [{**pl.model_dump(), "date": _in_range(pl.date)} for pl in body.planned]
    moved = {m.id: _in_range(m.date) for m in body.moved_bills}
    return forecast.what_if(db, planned, body.excluded_bill_ids, moved)


WHY_INSTRUCTIONS = (
    "Explain to a small business owner why their cash flow changed between the two periods, in two or three short "
    "sentences: the overall change first, then the two or three biggest reasons with their amounts. If customer "
    "payments are a reason, say whether invoices that fell due are still unpaid."
)


@router.get("/cash-flow/why")
def why(period: Literal["month", "30d"] = "month", p: Principal = Depends(require(Perm.VIEW_ALL)),
        db: Session = Depends(tenant_db)):
    """The numbers, plus a short explanation the AI writes from them only (fact-checked)."""
    w = health.why_cash_changed(db, period=period)
    m = wording.money
    facts = {"this period": f"{w['this_period']['from']} to {w['this_period']['to']}",
             "net cash flow this period": m(w["this_period"]["net_minor"]),
             "compared with": f"{w['last_period']['from']} to {w['last_period']['to']}",
             "net cash flow then": m(w["last_period"]["net_minor"]),
             "change": (f"{m(w['change_minor'])} better" if w["change_minor"] >= 0 else f"{m(-w['change_minor'])} worse"),
             "reasons, largest first": [
                 {"reason": r["label"],
                  "effect on cash": (f"{m(r['change_minor'])} more cash than last period" if r["change_minor"] > 0
                                     else f"{m(-r['change_minor'])} less cash than last period"),
                  "biggest items": [f"{i['label']} {m(i['change_minor'])}" for i in r["items"]],
                  **({"fell due and still unpaid this period": m(r["late_this_period_minor"]),
                      "fell due and still unpaid last period": m(r["late_last_period_minor"])}
                     if "late_this_period_minor" in r else {})} for r in w["reasons"][:5]]}
    text = wording.cached_write(p.business_id, "why_cash", WHY_INSTRUCTIONS, facts, wording.Names(db),
                                fallback=("Why cash changed", w["sentence"]),
                                paused=wording.ai_paused(db, p.business_id))
    w["explanation"] = {"text": text.body, "ai_written": text.ai_written, "redacted_input": text.ai_saw or ""}
    return w


@router.get("/business-health")
def business_health(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return health.summary(db)


@router.get("/home")
def home(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    today = date.today()
    f = forecast.build(db, today)
    h = health.summary(db, today)
    terms = ledger.terms(db)
    bills, _ = ledger.open_items(db, "bill")
    soon = [b for b in bills if ledger.due(b, terms) <= today + timedelta(days=7)]
    waiting = db.execute(select(func.count()).select_from(Action).where(Action.status == "pending")).scalar()
    recs = db.execute(select(func.count(), func.coalesce(func.sum(Recommendation.money_at_stake_minor), 0))
                      .where(Recommendation.status == "new")).one()
    today_items = [{"id": w["id"], "sentence": w["sentence"], "action_label": "See cash flow", "href": "/cash-flow",
                    "level": 0, "severity": w["severity"]} for w in f["warnings"]]
    if waiting:
        today_items.append({"id": "approvals", "sentence": f"{waiting} item{'s' if waiting != 1 else ''} "
                            f"{'need' if waiting != 1 else 'needs'} your approval.", "action_label": "Open inbox",
                            "href": "/inbox", "level": 0, "severity": "attention"})
    today_items += [{"id": c["id"], "sentence": c["sentence"], "action_label": "See business health",
                     "href": "/health", "level": 0, "severity": c["severity"]} for c in h["checks"]]
    position = ledger.cash(db)
    return {
        "today": today_items,
        "cash": {"balance_minor": position["balance_minor"], "as_of": position["as_of"],
                 "forecast": f["series"][:31], "lowest": f["lowest"], "horizons": f["horizons"]},
        "bills_due": {"count": len(soon), "total_minor": sum(b.open_minor for b in soon),
                      "next_due_date": min((ledger.due(b, terms) for b in bills), default=None)},
        "who_owes_you": {"count": h["owed"]["count"], "total_minor": h["owed"]["total_minor"],
                         "overdue_minor": h["owed"]["overdue_minor"]},
        "recommendations": {"count": recs[0], "at_stake_minor": int(recs[1])},
    }


# ── Matches ────────────────────────────────────────────────────────────────


def _record(r: Record | None, names: dict) -> dict | None:
    if not r:
        return None
    return {"id": str(r.id), "kind": r.kind, "source": r.source, "date": r.date.isoformat(),
            "amount_minor": r.amount_minor, "open_minor": r.open_minor, "reference": r.reference,
            "description": r.description, "counterparty": names.get(r.counterparty_id)}


@router.get("/matches")
def matches(status: Literal["suggested", "accepted", "rejected", "withdrawn"] = "suggested", limit: int = 100,
            p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    """Matches with both sides. Accept or reject a suggestion through its action in the inbox."""
    rows = db.execute(select(Match).where(Match.status == status).order_by(Match.created_at.desc())
                      .limit(max(1, min(limit, 500)))).scalars().all()
    ids = {i for m in rows for i in (m.left_id, m.right_id)}
    recs = {r.id: r for r in db.execute(select(Record).where(Record.id.in_(ids))).scalars()} if ids else {}
    acts = {}
    if rows:
        for a in db.execute(select(Action).where(Action.type == "accept_match", Action.payload["match_id"].astext.in_(
                [str(m.id) for m in rows]))).scalars():
            acts[a.payload["match_id"]] = {"id": str(a.id), "status": a.status}
    names = ledger.names(db)
    return {"items": [{"id": str(m.id), "score": m.score, "rule": m.rule, "signals": m.signals, "status": m.status,
                       "amount_minor": m.amount_minor, "target": _record(recs.get(m.left_id), names),
                       "payment": _record(recs.get(m.right_id), names), "action": acts.get(str(m.id))}
                      for m in rows]}


# ── Planned costs and the safety level ─────────────────────────────────────


def _plan_out(pl: PlannedItem) -> dict:
    return {"id": str(pl.id), "label": pl.name, "amount_minor": pl.amount_minor, "date": pl.date.isoformat(),
            "repeat": pl.repeat, "direction": pl.direction}


@router.get("/planned-items")
def planned_items(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    rows = db.execute(select(PlannedItem).where(PlannedItem.active.is_(True)).order_by(PlannedItem.date)).scalars()
    return {"items": [_plan_out(pl) for pl in rows]}


@router.post("/planned-items")
def add_planned(body: Plan, p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    """Keep a planned cost (or money in) in the forecast. Real records are not changed."""
    if db.execute(select(func.count()).select_from(PlannedItem).where(PlannedItem.active.is_(True))).scalar() >= 50:
        raise HTTPException(409, "You have 50 planned items already. Remove one first.")
    pl = PlannedItem(business_id=p.business_id, name=body.label, direction=body.direction,
                     amount_minor=body.amount_minor, date=_in_range(body.date), repeat=body.repeat,
                     created_by=p.user_id)
    db.add(pl)
    db.flush()
    audit.record(db, p.business_id, p.actor, "planned_item_added", subject=f"planned:{pl.id}",
                 details={"amount_minor": pl.amount_minor, "direction": pl.direction, "repeat": pl.repeat})
    events.publish(p.business_id, "forecast", {"planned": str(pl.id)})
    return _plan_out(pl)


@router.delete("/planned-items/{item_id}")
def remove_planned(item_id: UUID, p: Principal = Depends(require(Perm.USE_FINANCING)),
                   db: Session = Depends(tenant_db)):
    pl = db.get(PlannedItem, item_id)
    if not pl or not pl.active:
        raise HTTPException(404, "Not found.")
    pl.active = False
    audit.record(db, p.business_id, p.actor, "planned_item_removed", subject=f"planned:{pl.id}")
    events.publish(p.business_id, "forecast", {"planned": str(pl.id)})
    return {"ok": True}


@router.put("/settings/safety-level")
def set_safety_level(body: SafetyIn, p: Principal = Depends(require(Perm.SET_LIMITS)),
                     db: Session = Depends(tenant_db)):
    b = db.get(Business, p.business_id)
    before = b.safety_level_minor
    b.safety_level_minor = body.amount_minor
    audit.record(db, b.id, p.actor, "safety_level_changed", details={"before": before, "after": body.amount_minor})
    events.publish(b.id, "forecast", {"safety_level": body.amount_minor})
    return {"safety_level_minor": b.safety_level_minor}
