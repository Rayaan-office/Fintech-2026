"""Bug: Bright Cafe pays 4 days later on its recent invoices, but "getting slower" was never
said. We split invoices by due date, so older invoices due just after the cut diluted the
recent ones, and we asked for 5 days. Now: invoices issued in the last 60 days against those
before, 3 or more days later, and at least 7 days late."""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import rules
from app.db import tenant_session

TODAY = date.today()


def test_customer_getting_slower_is_said(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", "Bright Cafe")
        cp.payment_terms_days = 14
        for weeks_ago in range(26, 4, -1):
            issued = TODAY - timedelta(weeks=weeks_ago)
            late = 12 + (4 if issued >= TODAY - timedelta(days=60) else 0)
            story_books.record(db, bid, "invoice", 400_00, issued, counterparty_id=cp.id, status="paid", open_minor=0,
                               due_date=issued + timedelta(days=14), paid_date=issued + timedelta(days=14 + late))
        f = rules.slow_payers(db, TODAY)[0]
    assert f.title == "Bright Cafe pays late and is getting slower"
    assert f.facts["average days late on invoices of the last 60 days"] == "16"
