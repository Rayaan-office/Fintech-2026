"""Retrying an approved bill after a QuickBooks hiccup put the bill in QuickBooks twice.

The bill was made, then attaching the original failed; the next attempt made a second bill.
Every write now carries a request id based on the approval, so QuickBooks answers a repeat with
the bill it already made, and a failed attempt doesn't use up the approval.
"""

from tests.backend.integration.test_accounting_software import _approved_bill, _connect, _realm, biz, fake_qbo  # noqa: F401


def test_retry_makes_one_bill(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    fake_qbo.fail(f"{_realm(biz.id)}/upload", 503)
    assert biz.finance.post(f"/api/actions/{aid}/approve").status_code == 502
    assert biz.finance.post(f"/api/actions/{aid}/approve").json()["status"] == "executed"
    made = [b for b in fake_qbo.bills(_realm(biz.id)).values() if b.get("DocNumber") == "OD-4471"]
    assert len(made) == 1
    assert len(fake_qbo.uploads) == 1
