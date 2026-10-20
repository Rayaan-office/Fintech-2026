"""Bug: anyone who could see all records could cancel any waiting action, including a two-person
bank-detail change someone else had asked for, or an AI suggestion an owner had not looked at.
Fix: only the person who asked for it, or a business owner, can cancel it; other attempts are refused
and logged."""

from sqlalchemy import text
from tests.backend import story_books

from app import actions
from app.db import tenant_session
from app.models import Action


def _propose(bid, requested_by: str):
    with tenant_session(bid) as db:
        return actions.propose(db, bid, "change_supplier_bank", requested_by=requested_by,
                               summary="New bank details for Acme", payload={}).id


def _status(bid, aid) -> str:
    with tenant_session(bid) as db:
        return db.get(Action, aid).status


def test_only_the_requester_or_an_owner_can_cancel(businesses, sign_in):
    bid, tag = story_books.new_business()
    books, finance, owner = (sign_in(f"{r}@{tag}.test") for r in ("books", "finance", "owner"))
    finance_id = f"user:{finance.get('/api/auth/me').json()['user']['id']}"

    theirs = _propose(bid, finance_id)
    r = books.post(f"/api/actions/{theirs}/cancel")
    assert r.status_code == 403 and "Only the person who asked" in r.json()["detail"]
    assert _status(bid, theirs) == "pending"
    with tenant_session(bid) as db:
        assert db.execute(text("SELECT count(*) FROM audit_log WHERE event = 'cancel_refused' AND subject = :s"),
                          {"s": f"action:{theirs}"}).scalar() == 1
    assert finance.post(f"/api/actions/{theirs}/cancel").json()["status"] == "cancelled"

    suggested = _propose(bid, "ai:ingestion")
    assert finance.post(f"/api/actions/{suggested}/cancel").status_code == 403
    assert owner.post(f"/api/actions/{suggested}/cancel").json()["status"] == "cancelled"
