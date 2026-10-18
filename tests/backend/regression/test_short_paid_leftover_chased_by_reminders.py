"""Bug: a payment that arrived £18.60 short (a bank charge on the way) left the invoice open for
£18.60, and the payment reminder chased the customer for it, as if they still owed it. Now the
leftover is "short paid": it is never in a reminder, and it is closed by recording a bank charge."""

from datetime import date, timedelta

from tests.backend import getting_paid_books

from app.analytics import getting_paid
from app.copilot import insights
from app.copilot.wording import day
from app.db import tenant_session
from app.models import Counterparty, Record

TODAY = date.today()


def test_a_short_paid_leftover_is_not_chased_by_reminders(businesses):
    shop = getting_paid_books.short_paid_business()
    with tenant_session(shop.id) as db:
        chases = getting_paid.chase_overdue(db, TODAY)
        facts, body = insights.reminder_facts(db, db.get(Counterparty, shop.ids.cp))  # the assistant's reminder
    assert [f.next_step["record_ids"] for f in chases] == [[str(shop.ids.late)]]  # INV-9002 only
    assert facts["overdue invoices"] == [f"INV-9002: £360.00, due {day(TODAY - timedelta(days=10))}"]
    assert "INV-9001" not in body and "18.60" not in body


def test_nothing_is_chased_when_only_the_leftover_remains(businesses):
    shop = getting_paid_books.short_paid_business()
    with tenant_session(shop.id) as db:
        db.get(Record, shop.ids.late).status = "void"
        assert db.get(Record, shop.ids.paid).open_minor == getting_paid_books.SHORT
        assert getting_paid.chase_overdue(db, TODAY) == []
