"""Invoices paid in QuickBooks had no paid date.

QuickBooks says an invoice is paid but not when, so how long customers take to pay (and the
forecast's sense of each customer's habits) had nothing to go on for the accounting books.
The paid date is now the day of the last payment that settled it.
"""

from datetime import date, timedelta

from tests.backend.integration.test_accounting_software import _connect, _records, biz, fake_qbo  # noqa: F401


def test_paid_invoice_gets_the_payment_date(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    recs = _records(biz.id)
    assert recs["Invoice:101"].paid_date == date.today() - timedelta(days=25)
    assert recs["Invoice:102"].paid_date is None  # still open
