"""Recommendations, financing, the business profile and the lender pack.

Reading is open to everyone who can see the business's records (financing to finance managers
and owners). Anything that reaches outside, such as an email or sharing the lender pack, becomes
an action that waits for approval.
"""

from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import actions, archive, events
from ..analytics import financing, lender_pack, rules
from ..connectors import email_out
from ..copilot import insights, wording
from ..models import Action, Counterparty, Mute, Recommendation
from ..security import audit
from ..security.http import limiter
from ..security.rbac import Perm
from .deps import Principal, require, tenant_db
from .inbox import action_out

router = APIRouter(prefix="/api", tags=["advice"])

MAX_MINOR = 100_000_000_00
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


# ── Recommendations ────────────────────────────────────────────────────────


def rec_out(db: Session, r: Recommendation, names: dict) -> dict:
    f = r.facts or {}
    step = dict(r.next_step or {})
    related = step.pop("related_actions", None) or []
    pending = None
    if step.get("action_id"):
        a = db.get(Action, UUID(step["action_id"]))
        pending = {"id": step["action_id"], "status": a.status} if a else None
    return {
        "id": str(r.id), "type": r.kind, "title": r.title,
        "summary": {"text": r.body, "redacted_input": f.get("ai_saw") or "", "ai_written": r.ai_written},
        "severity": rules.APP_SEVERITY.get(r.severity, "info"), "grade": r.severity,
        "at_stake_minor": r.money_at_stake_minor or None, "counterparty": names.get(r.counterparty_id),
        "counterparty_id": str(r.counterparty_id) if r.counterparty_id else None,
        "created_at": r.created_at.isoformat(), "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "status": r.status, "why": f.get("why", ""), "evidence": f.get("evidence", []),
        "next_step": {"label": step.get("label"), "kind": step.get("action"), "href": step.get("href"),
                      "can_draft": bool(step.get("action")) and r.status == "new" and not pending,
                      "action": pending, "related_action_ids": related} if step.get("label") else None,
        "can_mute": r.kind != "bank_details_changed",
    }


@router.get("/recommendations")
def recommendations(status: str = "new", p: Principal = Depends(require(Perm.VIEW_ALL)),
                    db: Session = Depends(tenant_db)):
    q = select(Recommendation).order_by(Recommendation.score.desc(), Recommendation.updated_at.desc())
    if status != "all":
        if status not in ("new", "dismissed", "done", "resolved"):
            raise HTTPException(422, "Unknown status.")
        q = q.where(Recommendation.status == status)
    names = {c.id: c.display_name for c in db.execute(select(Counterparty)).scalars()}
    return {"items": [rec_out(db, r, names) for r in db.execute(q.limit(100)).scalars()]}


@router.post("/recommendations/refresh")
def refresh(p: Principal = Depends(require(Perm.VIEW_ALL))):
    """Check now, instead of waiting for new data or the daily run."""
    limiter.check(f"insights:{p.business_id}", 6, 600)
    return insights.run(p.business_id)


class DismissIn(BaseModel):
    mute: bool = True


@router.post("/recommendations/{rec_id}/dismiss")
def dismiss(rec_id: UUID, body: DismissIn | None = None, p: Principal = Depends(require(Perm.VIEW_ALL)),
            db: Session = Depends(tenant_db)):
    """Dismissing mutes that kind of recommendation for that supplier or customer.
    Changed bank details are never muted: a different change is always shown."""
    r = db.get(Recommendation, rec_id)
    if not r:
        raise HTTPException(404, "Not found.")
    r.status = "dismissed"
    muted = bool((body or DismissIn()).mute) and r.kind != "bank_details_changed"
    if muted and not db.execute(select(Mute).where(Mute.kind == r.kind, Mute.counterparty_id == r.counterparty_id)).first():
        db.add(Mute(business_id=p.business_id, kind=r.kind, counterparty_id=r.counterparty_id))
    audit.record(db, p.business_id, p.actor, "recommendation_dismissed", subject=f"recommendation:{r.id}",
                 details={"kind": r.kind, "muted": muted})
    events.publish(p.business_id, "recommendations", {"id": str(r.id), "status": "dismissed"})
    return {"ok": True, "muted": muted}


@router.post("/recommendations/{rec_id}/next-step")
def next_step(rec_id: UUID, p: Principal = Depends(require(Perm.SEND_REMINDER)), db: Session = Depends(tenant_db)):
    """Draft the suggested email. It waits in the inbox for approval; nothing is sent yet."""
    r = db.get(Recommendation, rec_id)
    if not r:
        raise HTTPException(404, "Not found.")
    step = r.next_step or {}
    if r.status != "new" or step.get("action") not in ("email_supplier", "send_payment_reminder"):
        raise HTTPException(409, "There is no email to draft for this recommendation.")
    if step.get("action_id"):
        a = db.get(Action, UUID(step["action_id"]))
        if a and a.status == "pending":
            return {"action": action_out(db, a, p)}
    limiter.check(f"draft:{p.user_id}", 20, 600)
    d = insights.draft_for_recommendation(db, r)
    a = propose_email(db, p, step["action"], d, recommendation_id=r.id)
    r.next_step = {**step, "action_id": str(a.id)}
    return {"action": action_out(db, a, p)}


def propose_email(db: Session, p: Principal, action_type: str, d: "insights.Draft", recommendation_id=None) -> Action:
    if not d.to:
        raise HTTPException(409, f"We don't have an email address on record for {d.counterparty.display_name}.")
    try:
        email_out.check("someone@example.com", d.subject, d.body)  # same checks as when it is sent
    except email_out.SendRefused as e:
        raise HTTPException(409, str(e))
    payload: dict[str, Any] = {"counterparty_id": str(d.counterparty.id), "subject": d.subject, "body": d.body,
                               "ai_written": d.written.ai_written}
    if d.contact_as_of:
        payload["contact_as_of"] = d.contact_as_of
    if recommendation_id:
        payload["recommendation_id"] = str(recommendation_id)
    return actions.propose(
        db, p.business_id, action_type, payload=payload, requested_by=p.actor,
        summary=f"Email {d.counterparty.display_name}: {d.subject}",
        effects=[f"Send this email to {d.to}" + (" (the address on record before the change)" if d.contact_as_of
                                                 else ""), f"Subject: {d.subject}", d.body],
        reasons=["Emails to suppliers and customers go out only after a person approves them."]
        + (["The AI drafted this email; check the wording."] if d.written.ai_written else []))


# ── Financing ──────────────────────────────────────────────────────────────

SUMMARY_INSTRUCTIONS = (
    "Summarise the business's financing position for the owner in two or three sentences: the shortfall, if any, "
    "the cheapest option that covers it and what it costs, and the main thing to improve before applying. "
    "Present it as information, not advice."
)


def _summary(db: Session, p: Principal, o: dict) -> dict:
    g = o["gap"]
    top = [x for x in o["options"] if x["eligible"] and x.get("quote")]
    covering = [x for x in top if x["quote"]["closes_gap"]]
    facts = {"shortfall": (f"cash goes below the safety level of {wording.money(g['safety_level_minor'])} from "
                           f"{wording.day(date.fromisoformat(g['starts_on']))} for about {g['days']} days; the lowest "
                           f"point is {wording.money(g['lowest_minor'])} on {wording.day(date.fromisoformat(g['lowest_on']))}, "
                           f"{wording.money(g['safety_level_minor'] - g['lowest_minor'])} below it") if g else "none",
             "amount looked at (the shortfall plus 5% for the cost of borrowing)":
                 wording.money(g["amount_minor"]) if g else "none",
             "options that keep cash above the safety level": [
                 f"{x['product']}: {wording.money(x['quote']['total_cost_minor'])} in total" for x in covering[:3]] or "none",
             "free options": [x["product"] for x in top if x["free"]][:2] or "none",
             "to improve": [r["label"] for r in o["readiness"] if not r["ok"]][:3] or "nothing"}
    short = wording.money(g["safety_level_minor"] - g["lowest_minor"]) if g else ""
    if g and covering:
        fb = (f"Cash is expected to fall up to {short} below your safety level from "
              f"{wording.day(date.fromisoformat(g['starts_on']))}. {covering[0]['product']} would cover it for "
              f"{wording.money(covering[0]['quote']['total_cost_minor'])} in total.")
    elif g:
        fb = (f"Cash is expected to fall up to {short} below your safety level from "
              f"{wording.day(date.fromisoformat(g['starts_on']))}.")
    else:
        fb = "No shortfall is forecast in the next 90 days. You can still compare options for a planned cost."
    w = wording.cached_write(p.business_id, "financing_summary", SUMMARY_INSTRUCTIONS, facts, wording.Names(db),
                             fallback=("Financing", fb), paused=wording.ai_paused(db, p.business_id))
    return {"text": w.body, "ai_written": w.ai_written, "redacted_input": w.ai_saw or ""}


@router.get("/financing")
def get_financing(amount_minor: int | None = None, months: int | None = None, purpose: str | None = None,
                  p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    if amount_minor is not None and not 0 < amount_minor <= MAX_MINOR:
        raise HTTPException(422, "Choose an amount above zero.")
    if months is not None and not 1 <= months <= 120:
        raise HTTPException(422, "Choose between 1 and 120 months.")
    if purpose is not None and purpose not in financing.PURPOSES:
        raise HTTPException(422, "Unknown purpose.")
    o = financing.options(db, amount=amount_minor, months=months, purpose=purpose)
    o["summary"] = _summary(db, p, o)
    o["lender_pack"] = {"available": True, "can_share": p.can(Perm.USE_FINANCING),
                        "approver": "A business owner approves sharing it."}
    return o


class QuoteIn(BaseModel):
    option_id: Annotated[str, StringConstraints(max_length=60)]
    amount_minor: int = Field(gt=0, le=MAX_MINOR)
    months: int = Field(ge=1, le=120)


@router.post("/financing/quote")
def quote(body: QuoteIn, p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    try:
        return financing.quote_one(db, body.option_id, body.amount_minor, body.months)
    except LookupError:
        raise HTTPException(404, "Unknown option.")
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/business-profile")
def get_profile(p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    return financing.profile(db)


class ProfileIn(BaseModel):
    owner_fields: dict[str, Text | None] = Field(default_factory=dict, max_length=10)
    # A correction to an automatic value (null: back to the automatic one)
    overrides: dict[str, float | int | None] = Field(default_factory=dict, max_length=12)


@router.put("/business-profile")
def put_profile(body: ProfileIn, p: Principal = Depends(require(Perm.EDIT_PROFILE)), db: Session = Depends(tenant_db)):
    try:
        financing.save_profile(db, p.business_id, p.user_id, body.owner_fields, body.overrides)
    except ValueError as e:
        raise HTTPException(422, str(e))
    audit.record(db, p.business_id, p.actor, "profile_updated",
                 details={"fields": sorted(body.owner_fields), "corrected": sorted(body.overrides)})
    db.flush()
    return financing.profile(db)


# ── Lender pack ────────────────────────────────────────────────────────────


@router.get("/lender-pack.pdf")
def lender_pack_pdf(p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    limiter.check(f"pack:{p.user_id}", 10, 600)
    pdf, f = lender_pack.build_pdf(db)
    audit.record(db, p.business_id, p.actor, "lender_pack_downloaded", details={"bytes": len(pdf)})
    name = f"lender-pack-{f['today']:%Y-%m-%d}.pdf"
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


class ShareIn(BaseModel):
    lender_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    email: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=254)]


@router.post("/lender-pack/share")
def share_pack(body: ShareIn, p: Principal = Depends(require(Perm.USE_FINANCING)), db: Session = Depends(tenant_db)):
    """Prepare the pack and ask a business owner to approve sending it. The PDF is stored now, so the
    approver sends exactly what was prepared."""
    limiter.check(f"pack:{p.user_id}", 10, 600)
    try:
        email_out.check(body.email, "Lender pack", "Lender pack")
    except email_out.SendRefused as e:
        raise HTTPException(422, str(e))
    pdf, f = lender_pack.build_pdf(db)
    key, sha = archive.put(p.business_id, pdf)
    a = actions.propose(
        db, p.business_id, "share_lender_pack", requested_by=p.actor,
        payload={"object_key": key, "sha256": sha, "email": body.email, "lender_name": body.lender_name,
                 "filename": f"lender-pack-{f['today']:%Y-%m-%d}.pdf", "prepared_on": f"{f['today']:%-d %B %Y}"},
        summary=f"Share the lender pack with {body.lender_name} ({body.email})",
        effects=[f"Email the lender pack PDF to {body.email}",
                 ("It contains your business profile, profit and loss for 12 months, "
                 f"{len(f['invoices'])} unpaid invoices with customer names, and the cash forecast")],
        reasons=["Sharing your figures with a lender is an outside action: a business owner must approve it.",
                 "We never apply for financing on your behalf."])
    return {"action": action_out(db, a, p)}
