"""A pair a person turned down came back as a new suggestion on the next run."""

from datetime import date, timedelta

from sqlalchemy import select
from tests.backend import story_books

from app.db import tenant_session
from app.handlers import run_matching
from app.models import Action, Match

TODAY = date.today()


def test_turned_down_pair_stays_turned_down(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        story_books.record(db, bid, "invoice", 1_366_84, TODAY - timedelta(days=11),
                           due_date=TODAY - timedelta(days=1), counterparty_id=cafe.id)
        story_books.record(db, bid, "bank_txn", 1_366_84, TODAY - timedelta(days=2), direction="in",
                           description="BRIGHT CAFE PAYMENT")
        assert run_matching(db, bid)["suggested"] == 1
        m = db.execute(select(Match)).scalar_one()
        m.status = "rejected"
        db.execute(select(Action)).scalar_one().status = "rejected"
        db.flush()
        assert run_matching(db, bid)["suggested"] == 0
        assert db.execute(select(Match)).scalar_one().status == "rejected"
