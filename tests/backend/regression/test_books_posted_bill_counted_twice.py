"""A bill we added to QuickBooks came back on the next read as a second bill.

The approved document already had its record; reading QuickBooks then saved the same bill again
from QuickBooks' side, so the bill was owed twice. Bills we added are now recognised by their
QuickBooks id and only update the record we already have (for example when paid in QuickBooks).
"""

from sqlalchemy import select
from tests.backend.integration.test_accounting_software import (  # noqa: F401
    _action,
    _approved_bill,
    _connect,
    _later,
    _realm,
    _records,
    biz,
    fake_qbo,
)

from app import scheduler
from app.db import tenant_session
from app.models import Record


def test_one_record_per_bill(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    assert biz.finance.post(f"/api/actions/{aid}/approve").json()["status"] == "executed"
    bill_id = _action(biz.id, aid).result["quickbooks_bill_id"]
    fake_qbo.change(_realm(biz.id), "Bill", bill_id, Balance=0)  # paid in QuickBooks
    scheduler.poll_books(_later(11))
    assert f"Bill:{bill_id}" not in _records(biz.id)
    with tenant_session(biz.id) as db:
        ours = db.execute(select(Record).where(Record.source == "document")).scalar_one()
        assert (ours.status, ours.open_minor) == ("paid", 0)
