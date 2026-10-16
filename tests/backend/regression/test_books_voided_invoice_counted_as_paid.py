"""A voided invoice showed as paid.

QuickBooks keeps a voided invoice with its amounts set to zero. With nothing left to pay we
marked it "paid", so it counted as income received. Zero-amount items are now void.
"""

from tests.backend.integration.test_accounting_software import (  # noqa: F401
    _connect,
    _later,
    _realm,
    _records,
    biz,
    fake_qbo,
)

from app import scheduler


def test_voided_invoice_is_void(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    fake_qbo.change(_realm(biz.id), "Invoice", "102", TotalAmt=0, Balance=0, PrivateNote="Voided")
    scheduler.poll_books(_later(11))
    inv = _records(biz.id)["Invoice:102"]
    assert (inv.status, inv.open_minor) == ("void", 0)
