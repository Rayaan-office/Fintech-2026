"""A change made in QuickBooks while we were reading it was never picked up.

The change feed's starting point was taken after the full read had finished, so anything
changed during the read fell between the two. The starting point is now taken before the
read, a few minutes early; reading something twice does no harm.
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


def test_change_during_the_read_arrives_next_time(biz, fake_qbo):  # noqa: F811
    realm = fake_qbo.company()
    # Invoices have been read when the customer's payment lands
    fake_qbo.during_read = ("Purchase", lambda: fake_qbo.change(realm, "Invoice", "102", Balance=0))
    _connect(biz, fake_qbo, realm)
    assert _records(biz.id)["Invoice:102"].status == "open"
    scheduler.poll_books(_later(11))
    assert _records(biz.id)["Invoice:102"].status == "paid"
