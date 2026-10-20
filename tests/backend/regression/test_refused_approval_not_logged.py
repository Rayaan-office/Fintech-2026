"""Bug: a refused approval was written to the activity log inside the request's own transaction,
which is undone when the request is refused, so no refusal was ever kept.
Fix: the refusal is logged in a transaction of its own."""

from sqlalchemy import text
from tests.backend import story_books

from app import actions
from app.db import tenant_session


def test_a_refused_approval_stays_in_the_log(businesses, sign_in):
    bid, tag = story_books.new_business()
    with tenant_session(bid) as db:
        aid = actions.propose(db, bid, "change_supplier_bank", requested_by="ai:ingestion",
                              summary="New bank details for Acme", payload={}).id
    assert sign_in(f"books@{tag}.test").post(f"/api/actions/{aid}/approve").status_code == 403
    with tenant_session(bid) as db:
        reasons = db.execute(text("SELECT details->>'reason' FROM audit_log WHERE event = 'approval_refused'"
                                  " AND subject = :s"), {"s": f"action:{aid}"}).scalars().all()
    assert reasons == ["Only business owners, finance managers or the named second approver can approve this."]
