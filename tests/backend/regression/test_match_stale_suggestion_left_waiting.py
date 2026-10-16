"""A suggestion stayed in the inbox after the invoice was paid another way.

When the accounting software marked the invoice paid (or the payment was voided), the old
suggestion still waited for approval, and approving it took the amount off a second time.
Stale suggestions are now withdrawn on the next matching run, and approving one is refused.
"""

from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from tests.backend import story_books

from app import actions
from app.db import tenant_session
from app.handlers import run_matching
from app.models import Action, Match

TODAY = date.today()


def _setup(db, bid):
    cafe = story_books.party(db, bid, "customer", "Bright Cafe")
    inv = story_books.record(db, bid, "invoice", 1_366_84, TODAY - timedelta(days=11),
                             due_date=TODAY - timedelta(days=1), counterparty_id=cafe.id)
    story_books.record(db, bid, "bank_txn", 1_366_84, TODAY - timedelta(days=2), direction="in",
                       description="BRIGHT CAFE PAYMENT")
    assert run_matching(db, bid)["suggested"] == 1
    return inv


def test_paid_elsewhere_is_withdrawn(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        inv = _setup(db, bid)
        inv.status, inv.open_minor = "paid", 0  # paid in the accounting software
        db.flush()
        assert run_matching(db, bid)["withdrawn"] == 1
        assert db.execute(select(Match)).scalar_one().status == "withdrawn"
        a = db.execute(select(Action)).scalar_one()
        assert a.status == "cancelled" and a.result["reason"]


def test_approving_a_stale_suggestion_is_refused(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        inv = _setup(db, bid)
        inv.status, inv.open_minor = "paid", 0
        db.flush()
        a = db.execute(select(Action)).scalar_one()
        with pytest.raises(HTTPException) as e:
            actions._execute(db, a, "user:test")
        assert e.value.status_code == 409
        assert inv.open_minor == 0
