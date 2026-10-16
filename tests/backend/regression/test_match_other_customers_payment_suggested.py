"""A payment from one customer was suggested for another customer's invoice.

Green Leaf Bistro paid exactly the amount Bright Cafe owed, so the amount and dates scored
60 and it was suggested. A payment that clearly names a different customer or supplier we
know is never suggested.
"""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import matching
from app.db import tenant_session

TODAY = date.today()


def test_payment_from_another_customer_is_not_suggested(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        story_books.party(db, bid, "customer", "Green Leaf Bistro")
        story_books.record(db, bid, "invoice", 366_84, TODAY - timedelta(days=11), due_date=TODAY - timedelta(days=1),
                           reference="INV-2051", counterparty_id=cafe.id)
        story_books.record(db, bid, "bank_txn", 366_84, TODAY - timedelta(days=2), direction="in",
                           description="GREEN LEAF BISTRO PAYMENT")
        assert matching.find_candidates(db) == []


def test_payment_from_the_same_customer_still_is(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        story_books.party(db, bid, "customer", "Green Leaf Bistro")
        inv = story_books.record(db, bid, "invoice", 366_84, TODAY - timedelta(days=11),
                                 due_date=TODAY - timedelta(days=1), reference="INV-2051", counterparty_id=cafe.id)
        story_books.record(db, bid, "bank_txn", 366_84, TODAY - timedelta(days=2), direction="in",
                           description="BRIGHT CAFE PAYMENT")
        found = matching.find_candidates(db)
        assert [(c.target.id, c.score) for c in found] == [(inv.id, 70)]
