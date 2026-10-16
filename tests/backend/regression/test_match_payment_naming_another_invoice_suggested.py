"""A bank payment naming one invoice was suggested for another.

Bright Cafe's payment "REF INV-2045" was offered as the payment for INV-2049, because the
amount was close and the dates were near. A payment that names a different invoice of ours
paid that one, so it is never suggested for another.
"""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import matching
from app.db import tenant_session

TODAY = date.today()


def test_payment_naming_another_invoice_is_not_suggested(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        story_books.record(db, bid, "invoice", 433_80, TODAY - timedelta(days=25), due_date=TODAY - timedelta(days=11),
                           reference="INV-2049", counterparty_id=cafe.id)
        story_books.record(db, bid, "invoice", 430_80, TODAY - timedelta(days=40), status="paid",
                           reference="INV-2045", counterparty_id=cafe.id)
        story_books.record(db, bid, "bank_txn", 430_80, TODAY - timedelta(days=10), direction="in",
                           description="BRIGHT CAFE REF INV-2045", reference="BRIGHT CAFE REF INV-2045")
        assert matching.find_candidates(db) == []


def test_a_longer_number_is_not_mistaken_for_ours(businesses):
    """INV-204 is not found inside INV-2045."""
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cafe = story_books.party(db, bid, "customer", "Bright Cafe")
        story_books.record(db, bid, "invoice", 500_00, TODAY - timedelta(days=20), due_date=TODAY - timedelta(days=6),
                           reference="INV-204", counterparty_id=cafe.id)
        story_books.record(db, bid, "bank_txn", 500_00, TODAY - timedelta(days=5), direction="in",
                           description="BRIGHT CAFE REF INV-2045")
        found = matching.find_candidates(db)
        assert [c.rule for c in found] != ["invoice_number"]
