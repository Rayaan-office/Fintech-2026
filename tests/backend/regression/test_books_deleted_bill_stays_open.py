"""A bill deleted in QuickBooks stayed open with us, so the forecast still expected to pay it.

The change feed reports deletions as a bare id with status "Deleted". These were treated like
normal rows, and either broke the read or were saved with no amount. Deleted items are now
voided, and a full read also voids anything QuickBooks no longer has.
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
from app.connectors import quickbooks
from app.db import tenant_session


def test_deleted_bill_is_voided(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    fake_qbo.delete(_realm(biz.id), "Bill", "201")
    scheduler.poll_books(_later(11))
    bill = _records(biz.id)["Bill:201"]
    assert (bill.status, bill.open_minor, bill.amount_minor) == ("void", 0, 65100)


def test_deletion_older_than_the_change_feed_is_found_by_a_full_read(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    fake_qbo.companies[_realm(biz.id)]["rows"]["Bill"].pop("201")  # deleted long ago: not in the feed
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200
    assert _records(biz.id)["Bill:201"].status == "open"
    with tenant_session(biz.id) as db:
        quickbooks.sync(db, biz.id, full=True)
    assert _records(biz.id)["Bill:201"].status == "void"
