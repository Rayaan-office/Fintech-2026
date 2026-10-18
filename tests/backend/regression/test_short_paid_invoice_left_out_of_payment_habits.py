"""Bug: an invoice whose payment arrived a few pounds short never reached "paid", so it dropped
out of everything that looks at how customers pay: a customer paying 12 days late, every time by
international transfer, was never called a slow payer, and days to get paid ignored them. Now such
an invoice counts as paid on the day its payment arrived."""

from datetime import date, timedelta

from tests.backend import getting_paid_books, story_books

from app.analytics import forecast, health, rules
from app.db import tenant_session

TODAY = date.today()


def test_short_paid_invoices_count_as_paid_on_the_day_the_money_arrived(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", "Rotterdam Bakery BV")
        for n, weeks_ago in enumerate(range(12, 4, -2)):
            issued = TODAY - timedelta(weeks=weeks_ago)
            ref = f"INV-95{n:02d}"
            story_books.record(db, bid, "invoice", 400_00, issued, counterparty_id=cp.id, reference=ref,
                               due_date=issued + timedelta(days=14))
            story_books.record(db, bid, "bank_txn", 400_00 - 15_00, issued + timedelta(days=26), direction="in",
                               description=f"INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF {ref}")
        assert getting_paid_books.match(db, bid)["auto"] == 4
    with tenant_session(bid) as db:
        slow = rules.slow_payers(db, TODAY)
        late = forecast.lateness(db, TODAY)[cp.id]
        days = health.days_to_get_paid(db, TODAY)
    assert [f.facts["average days paid after the due date"] for f in slow] == ["12"]
    assert late[0] == 12 and late[2] == 4
    assert days == 26.0
