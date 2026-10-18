"""Getting paid: what payments cost and how long they take, and recording what arrived short."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import actions
from ..analytics import getting_paid, ledger
from ..copilot.wording import day, money
from ..models import Action, Counterparty, Recommendation
from ..security.rbac import Perm
from .deps import Principal, require, tenant_db
from .inbox import action_out

router = APIRouter(prefix="/api", tags=["getting paid"])


@router.get("/getting-paid")
def summary(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    return getting_paid.numbers(db)


@router.post("/recommendations/{rec_id}/bank-charge")
def bank_charge(rec_id: UUID, p: Principal = Depends(require(Perm.RECONCILE)), db: Session = Depends(tenant_db)):
    """Prepare recording what is left after short payments as bank charges. A finance manager or
    business owner approves it; nothing changes before then."""
    r = db.get(Recommendation, rec_id)
    if not r:
        raise HTTPException(404, "Not found.")
    step = r.next_step or {}
    if r.status != "new" or step.get("action") != "record_bank_charge":
        raise HTTPException(409, "There is no bank charge to record for this recommendation.")
    if step.get("action_id"):
        a = db.get(Action, UUID(step["action_id"]))
        if a and a.status == "pending":
            return {"action": action_out(db, a, p)}
    short = ledger.short_paid(db)
    left = [short[UUID(i)] for i in step.get("record_ids") or [] if UUID(i) in short
            and short[UUID(i)].record.status == "open" and short[UUID(i)].record.open_minor > 0]
    if not left:
        raise HTTPException(409, "There is nothing short left to record on these invoices.")
    total = sum(x.record.open_minor for x in left)
    cp = db.get(Counterparty, r.counterparty_id) if r.counterparty_id else None
    a = actions.propose(
        db, p.business_id, "record_bank_charge", requested_by=p.actor, amount_minor=total,
        payload={"record_ids": [str(x.record.id) for x in left], "recommendation_id": str(r.id)},
        summary=f"Record {money(total)} as bank charges on {len(left)} invoice{'s' if len(left) > 1 else ''}"
                + (f" from {cp.display_name}" if cp else ""),
        effects=[f"Record {money(x.record.open_minor)} as a bank charge on invoice {x.record.reference or ''}, "
                 f"which arrived short on {day(x.paid_on)}".replace("invoice ,", "invoice,") for x in left]
        + ["Mark those invoices as paid on the day their payment arrived"],
        reasons=["Recording a cost needs a finance manager or a business owner."])
    r.next_step = {**step, "action_id": str(a.id)}
    return {"action": action_out(db, a, p)}
