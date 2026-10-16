"""Payments the accounting software had already applied were suggested for other invoices.

A QuickBooks payment that paid INV-2045 (QuickBooks links it) was offered for INV-2049, and a
QuickBooks purchase was offered as payment of a QuickBooks bill. QuickBooks and Stripe record
exactly what each payment settled, so we never pair two items from the same one ourselves.
"""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import matching
from app.db import tenant_session

TODAY = date.today()


def test_linked_payment_and_same_system_pairs_are_left_alone(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        acme = story_books.party(db, bid, "supplier", "Acme Supplies Ltd")
        story_books.record(db, bid, "invoice", 433_80, TODAY - timedelta(days=25), due_date=TODAY - timedelta(days=11),
                           reference="INV-2049", counterparty_id=cafe.id)
        story_books.record(db, bid, "payment_in", 433_80, TODAY - timedelta(days=10), counterparty_id=cafe.id,
                           description="Customer payment INV-2045", external={"linked": ["Invoice:45"]})
        story_books.record(db, bid, "bill", 1_500_00, TODAY - timedelta(days=30), due_date=TODAY - timedelta(days=30),
                           counterparty_id=acme.id)
        story_books.record(db, bid, "payment_out", 1_500_00, TODAY - timedelta(days=27), counterparty_id=acme.id,
                           description="Purchase 2007", external={"qbo_type": "Purchase"})
        assert matching.find_candidates(db) == []
