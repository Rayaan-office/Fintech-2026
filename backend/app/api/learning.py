"""What we've learned from people's corrections and decisions, and resetting it.

Everyone who can see the business's records can read it. Only a business owner can reset it,
and every reset is written to the activity log.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy.orm import Session

from .. import events
from ..copilot import learning
from ..models import Counterparty, Recommendation
from ..security.rbac import Perm, Role
from .deps import Principal, require, tenant_db

router = APIRouter(prefix="/api", tags=["learning"])


def _owner(p: Principal) -> bool:
    return Role.OWNER in p.roles


@router.get("/learning")
def what_we_learned(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return {**learning.summary(db), "can_reset": _owner(p)}


class ResetIn(BaseModel):
    scope: Literal["all", "supplier", "field", "kind"]
    counterparty_id: UUID | None = None
    field: Literal["category_hint", "doc_type", "currency", "payment_terms", "counterparty_name"] | None = None
    kind: Annotated[str, StringConstraints(pattern=r"^[a-z_]{1,40}$")] | None = None


@router.post("/learning/reset")
def reset(body: ResetIn, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    """Forget one learned item, everything for one supplier, one kind's ranking, or all of it."""
    if not _owner(p):
        raise HTTPException(403, "Only a business owner can reset what we've learned.")
    if body.scope in ("supplier", "field") and not (body.counterparty_id and db.get(Counterparty, body.counterparty_id)):
        raise HTTPException(404, "Not found.")
    if body.scope == "field" and not body.field:
        raise HTTPException(422, "Choose what to forget.")
    if body.scope == "kind" and not body.kind:
        raise HTTPException(422, "Choose which kind of recommendation.")
    out = learning.reset(db, p.business_id, p.actor, body.scope, counterparty_id=body.counterparty_id,
                         field=body.field, kind=body.kind)
    events.publish(p.business_id, "recommendations", {"learning": "reset"})
    return {**out, **learning.summary(db), "can_reset": True}


@router.post("/recommendations/{rec_id}/followed")
def followed(rec_id: UUID, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    """The person opened the page a recommendation pointed to: it counts as acted on."""
    r = db.get(Recommendation, rec_id)
    if not r:
        raise HTTPException(404, "Not found.")
    if r.status == "new" and (r.next_step or {}).get("href") and not (r.next_step or {}).get("action"):
        learning.reward(db, r, won=True, actor=p.actor)
    return {"ok": True}
