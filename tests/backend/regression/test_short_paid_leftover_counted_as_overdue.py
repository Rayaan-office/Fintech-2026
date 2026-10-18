"""Bug: the £18.60 left on an invoice whose payment arrived short was counted as money the customer
owed: in "who owes you" (overdue, in the age buckets), in the cash forecast as money still to come,
and in the lender pack's unpaid invoices. Now it is shown apart, as short paid, and never as owed."""

from datetime import date

from tests.backend import getting_paid_books

from app.analytics import forecast, health, lender_pack
from app.db import tenant_session

TODAY = date.today()


def test_a_short_paid_leftover_is_not_owed(businesses):
    shop = getting_paid_books.short_paid_business()
    with tenant_session(shop.id) as db:
        owed = health.who_owes_you(db, TODAY)
        items = forecast.build(db, TODAY)["items"]
        pack = lender_pack.facts(db, TODAY)["invoices"]
    assert (owed["count"], owed["total_minor"], owed["overdue_minor"]) == (1, 360_00, 360_00)
    assert sum(b["amount_minor"] for b in owed["buckets"]) == 360_00
    assert (owed["short_paid_minor"], owed["short_paid_count"]) == (getting_paid_books.SHORT, 1)
    assert [i["label"] for i in items if i["kind"] == "invoice"] == ["Rotterdam Bakery BV invoice INV-9002"]
    assert [i["reference"] for i in pack] == ["INV-9002"]
