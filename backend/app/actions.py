"""Approvals: every change and outside action goes through here.

Each action type has a fixed level (security/rbac.py). The server checks the level, the
person's role and limits before anything runs. Level 4 needs two different people.
Level 2 may run automatically, but only when small, confident, from a known supplier,
with no warnings, and while AI is not paused; it can then be undone.
"""

from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import events
from .models import Action, Approval, Business, Notification
from .security import audit
from .security.rbac import ACTIONS, AI_FORBIDDEN, Level, Perm, Role

Handler = Callable[[Session, Action, str], dict]
_handlers: dict[str, Handler] = {}
_undo: dict[str, Handler] = {}
_on_reject: dict[str, Handler] = {}


def handler(action_type: str, undo: Handler | None = None, on_reject: Handler | None = None):
    def deco(fn: Handler) -> Handler:
        _handlers[action_type] = fn
        if undo:
            _undo[action_type] = undo
        if on_reject:
            _on_reject[action_type] = on_reject
        return fn

    return deco


def propose(db: Session, business_id, action_type: str, *, payload: dict, summary: str, requested_by: str,
            effects: list[str] | None = None, amount_minor: int | None = None, reasons: list[str] | None = None,
            auto_ok: bool = False, first_time_payee: bool = False) -> Action:
    """Create an action. If it qualifies for automatic handling, run it now."""
    if action_type in AI_FORBIDDEN or action_type not in ACTIONS:
        raise ValueError(f"unknown or forbidden action {action_type!r}")
    spec = ACTIONS[action_type]
    biz = db.get(Business, business_id)
    level = spec.level
    reasons = list(reasons or [])
    if action_type == "schedule_payment" and amount_minor is not None and (
            amount_minor >= biz.large_payment_minor or first_time_payee):
        level = Level.HIGH_RISK
        reasons.append("Large or first-time payment: two people must approve.")
    action = Action(
        business_id=business_id, type=action_type, level=int(level), summary=summary[:500], payload=payload,
        effects=effects or [], reasons=reasons, amount_minor=amount_minor, requested_by=requested_by,
        required_approvals=2 if level == Level.HIGH_RISK else 1,
    )
    db.add(action)
    db.flush()
    audit.record(db, business_id, requested_by, "action_proposed", subject=f"action:{action.id}",
                 details={"type": action_type, "level": int(level), "amount_minor": amount_minor})

    can_auto = (
        level == Level.SMALL_CHANGE and auto_ok and not reasons and not biz.ai_paused
        and (amount_minor is None or amount_minor <= biz.auto_approve_limit_minor)
    )
    if can_auto:
        _execute(db, action, actor="ai:auto")
    else:
        if level >= Level.SMALL_CHANGE and biz.ai_paused and auto_ok:
            action.reasons = reasons + ["AI is paused, so a person must approve."]
        db.add(Notification(business_id=business_id, kind="approval", title=action.summary,
                            link=f"/inbox?action={action.id}"))
    events.publish(business_id, "action", {"id": str(action.id), "status": action.status, "type": action_type})
    return action


def _execute(db: Session, action: Action, actor: str) -> None:
    fn = _handlers.get(action.type)
    if not fn:
        raise HTTPException(500, "This action cannot be carried out yet.")
    try:
        result = fn(db, action, actor) or {}
        action.status = "executed"
        action.result = result
    except HTTPException:
        raise
    except Exception as exc:  # fail closed and tell a person
        action.status = "failed"
        action.result = {"error": type(exc).__name__, "message": str(exc)[:200]}
    action.decided_at = datetime.now(UTC)
    audit.record(db, action.business_id, actor, f"action_{action.status}", subject=f"action:{action.id}",
                 details={"type": action.type, "level": action.level, "amount_minor": action.amount_minor})
    if action.status == "executed":
        _learn(db, action, True, actor)


def _learn(db: Session, action: Action, won: bool, actor: str) -> None:
    """An action drafted from a recommendation teaches the ranking whether it was useful."""
    if (action.payload or {}).get("recommendation_id"):
        from .copilot import learning

        learning.reward_action(db, action, won, actor)


def _may_approve(p, action: Action) -> str | None:
    """Returns why this person may not approve, or None if they may."""
    spec = ACTIONS[action.type]
    if action.level == Level.HIGH_RISK:
        if not (p.can(Perm.APPROVE_HIGH_RISK) and (set(p.roles) & {Role.OWNER, Role.FINANCE_MANAGER}
                                                  or p.second_approver)):
            return "Only business owners, finance managers or the named second approver can approve this."
        if action.requested_by == p.actor:
            return "You prepared this, so two other people must approve it."
    elif not p.can(spec.approve_perm):
        return "Your role does not allow approving this."
    if action.type in ("schedule_payment", "large_payment") and Role.OWNER not in p.roles:
        if p.approval_limit_minor is not None and (action.amount_minor or 0) > p.approval_limit_minor:
            return "This is above your approval limit."
    return None


def decide(db: Session, p, action_id, decision: str) -> Action:
    action = db.get(Action, action_id)
    if not action:
        raise HTTPException(404, "Not found.")
    if action.status != "pending":
        raise HTTPException(409, "This has already been decided.")
    why_not = _may_approve(p, action)
    if why_not:
        audit.record(db, action.business_id, p.actor, "approval_refused", subject=f"action:{action.id}",
                     details={"reason": why_not})
        raise HTTPException(403, why_not)
    already = db.execute(select(Approval).where(Approval.action_id == action.id, Approval.user_id == p.user_id)).first()
    if already:
        raise HTTPException(409, "You have already approved this. A different person must give the second approval.")
    db.add(Approval(business_id=action.business_id, action_id=action.id, user_id=p.user_id, decision=decision))
    db.flush()
    audit.record(db, action.business_id, p.actor, f"approval_{decision}", subject=f"action:{action.id}",
                 details={"type": action.type, "level": action.level})
    if decision == "reject":
        action.status = "rejected"
        action.decided_at = datetime.now(UTC)
        if action.type in _on_reject:
            _on_reject[action.type](db, action, p.actor)
        _learn(db, action, False, p.actor)
    else:
        approvals = db.execute(select(Approval).where(Approval.action_id == action.id,
                                                      Approval.decision == "approve")).scalars().all()
        if len({a.user_id for a in approvals}) >= action.required_approvals:
            _execute(db, action, actor=p.actor)
    events.publish(action.business_id, "action", {"id": str(action.id), "status": action.status, "type": action.type})
    return action


def cancel(db: Session, p, action_id) -> Action:
    action = db.get(Action, action_id)
    if not action or action.status != "pending":
        raise HTTPException(409, "Only waiting actions can be cancelled.")
    action.status = "cancelled"
    action.decided_at = datetime.now(UTC)
    audit.record(db, action.business_id, p.actor, "action_cancelled", subject=f"action:{action.id}")
    return action


def undo(db: Session, p, action_id) -> Action:
    action = db.get(Action, action_id)
    if not action or action.status != "executed" or action.level != Level.SMALL_CHANGE:
        raise HTTPException(409, "Only small automatic changes can be undone.")
    if not p.can(ACTIONS[action.type].approve_perm):
        raise HTTPException(403, "Your role does not allow undoing this.")
    fn = _undo.get(action.type)
    if not fn:
        raise HTTPException(409, "This change cannot be undone.")
    fn(db, action, p.actor)
    action.status = "undone"
    audit.record(db, action.business_id, p.actor, "action_undone", subject=f"action:{action.id}")
    events.publish(action.business_id, "action", {"id": str(action.id), "status": "undone", "type": action.type})
    return action


def approvers_needed(action: Action) -> str:
    if action.level == Level.HIGH_RISK:
        return "Two people: business owners or finance managers"
    if action.level == Level.OUTSIDE:
        return "One person"
    return "One person (or automatic when small and confident)"
