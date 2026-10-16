"""Inbox: everything waiting for a person, and the approve / reject / cancel / undo endpoints."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import actions
from ..db import global_session
from ..models import Action, Approval, Document, User
from ..security.rbac import ACTIONS, LEVEL_LABELS, Perm
from .deps import Principal, current_principal, page_params, require, tenant_db

router = APIRouter(prefix="/api", tags=["inbox"])


def _user_names(ids: set) -> dict:
    if not ids:
        return {}
    with global_session() as db:
        return {u.id: u.name for u in db.execute(select(User).where(User.id.in_(ids))).scalars()}


def action_out(db: Session, a: Action, p: Principal, names: dict | None = None) -> dict:
    approvals = db.execute(select(Approval).where(Approval.action_id == a.id).order_by(Approval.at)).scalars().all()
    ids = {ap.user_id for ap in approvals}
    if a.requested_by.startswith("user:"):
        ids.add(UUID(a.requested_by[5:]))
    names = names if names is not None else _user_names(ids)
    if a.requested_by.startswith("user:"):
        by = f"prepared by {names.get(UUID(a.requested_by[5:]), 'a colleague')}"
    else:
        by = "suggested by AI"
    why_not = None
    if a.status == "pending":
        why_not = actions._may_approve(p, a)
        if not why_not and any(ap.user_id == p.user_id for ap in approvals):
            why_not = "You have already approved this. A different person must give the second approval."
    return {
        "id": str(a.id), "type": a.type, "type_label": ACTIONS[a.type].label, "level": a.level,
        "level_label": LEVEL_LABELS[a.level], "status": a.status, "summary": a.summary, "effects": a.effects,
        "reasons": a.reasons, "amount_minor": a.amount_minor, "requested_by": by,
        "approvals": [{"name": names.get(ap.user_id, "Someone"), "decision": ap.decision, "at": ap.at.isoformat()}
                      for ap in approvals if ap.decision == "approve"],
        "required_approvals": a.required_approvals, "approvers": actions.approvers_needed(a),
        "can_approve": a.status == "pending" and why_not is None, "why_not": why_not,
        "can_undo": a.status == "executed" and a.level == 2 and a.type in actions._undo,
        "document_id": a.payload.get("document_id"), "result": a.result,
        "created_at": a.created_at.isoformat(), "decided_at": a.decided_at.isoformat() if a.decided_at else None,
    }


@router.get("/inbox")
def inbox(tab: str = "needs_approval", page=Depends(page_params), p: Principal = Depends(require(Perm.VIEW_ALL)),
          db: Session = Depends(tenant_db)):
    limit, offset = page
    counts = {
        "to_review": db.execute(select(func.count()).select_from(Document).where(Document.status == "review")).scalar(),
        "needs_approval": db.execute(select(func.count()).select_from(Action).where(Action.status == "pending")).scalar(),
    }
    if tab == "to_review":
        docs = db.execute(select(Document).where(Document.status == "review").order_by(Document.created_at.desc())
                          .limit(limit).offset(offset)).scalars().all()
        items = [{"kind": "document", "id": str(d.id), "summary": f"Check {d.filename}",
                  "reasons": d.review_reasons, "warnings": d.warnings, "created_at": d.created_at.isoformat(),
                  "level": 1, "level_label": LEVEL_LABELS[1]} for d in docs]
    else:
        q = select(Action)
        if tab == "needs_approval":
            # Highest risk and largest amounts first
            q = q.where(Action.status == "pending").order_by(Action.level.desc(), Action.amount_minor.desc().nulls_last(),
                                                             Action.created_at)
        else:
            q = q.where(Action.status != "pending").order_by(Action.decided_at.desc().nulls_last())
        rows = db.execute(q.limit(limit).offset(offset)).scalars().all()
        items = [action_out(db, a, p) for a in rows]
    return {"items": items, "counts": counts}


@router.get("/actions/{action_id}")
def get_action(action_id: UUID, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    a = db.get(Action, action_id)
    if not a:
        raise HTTPException(404, "Not found.")
    return action_out(db, a, p)


def _decided(db, a, p):
    out = action_out(db, a, p)
    if a.status == "failed":
        raise HTTPException(502, (a.result or {}).get("message") or "The action could not be completed.")
    return out


@router.post("/actions/{action_id}/approve")
def approve(action_id: UUID, p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    return _decided(db, actions.decide(db, p, action_id, "approve"), p)


@router.post("/actions/{action_id}/reject")
def reject(action_id: UUID, p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    return action_out(db, actions.decide(db, p, action_id, "reject"), p)


@router.post("/actions/{action_id}/cancel")
def cancel(action_id: UUID, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return action_out(db, actions.cancel(db, p, action_id), p)


@router.post("/actions/{action_id}/undo")
def undo(action_id: UUID, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return action_out(db, actions.undo(db, p, action_id), p)
