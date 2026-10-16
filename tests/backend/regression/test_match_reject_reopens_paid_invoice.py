"""Turning down a suggestion reopened an invoice that was already paid.

Rejecting a match gave its amount back to the invoice and set it to open, even when the match
had only been suggested and never accepted. Only an accepted match changed what is owed, so
only that is given back.
"""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import matching
from app.db import tenant_session
from app.models import Match

TODAY = date.today()


def test_rejecting_a_suggestion_leaves_the_invoice_alone(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        inv = story_books.record(db, bid, "invoice", 300_00, TODAY - timedelta(days=20), status="paid")
        pay = story_books.record(db, bid, "bank_txn", 300_00, TODAY - timedelta(days=3), direction="in")
        m = Match(business_id=bid, left_id=inv.id, right_id=pay.id, amount_minor=300_00, score=70, rule="score",
                  status="suggested")
        db.add(m)
        db.flush()
        matching.unsettle(db, m)
        assert (inv.status, inv.open_minor, m.status) == ("paid", 0, "rejected")


def test_rejecting_an_accepted_match_gives_the_amount_back(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        inv = story_books.record(db, bid, "invoice", 300_00, TODAY - timedelta(days=20))
        pay = story_books.record(db, bid, "bank_txn", 300_00, TODAY - timedelta(days=3), direction="in")
        m = matching.apply(db, matching.Candidate(inv, pay, 100, "invoice_number", {}, 300_00), "accepted", "x")
        assert (inv.status, inv.open_minor) == ("paid", 0)
        matching.unsettle(db, m)
        assert (inv.status, inv.open_minor, inv.paid_date) == ("open", 300_00, None)
