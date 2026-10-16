"""A failed QuickBooks read could sign the business out for good.

Intuit replaces the refresh token on every refresh and the old one stops working. The new
token was saved in the same transaction as the read, so when the read then failed, the new
token was rolled back with it and only the dead one was left. It is now saved straight away,
in its own transaction.
"""

from tests.backend.integration.test_accounting_software import _connect, _connection, _realm, biz, fake_qbo  # noqa: F401


def test_new_token_survives_a_failed_read(biz, fake_qbo):  # noqa: F811
    fake_qbo.expires_in = 60  # every call refreshes first
    _connect(biz, fake_qbo)
    fake_qbo.fail(f"{_realm(biz.id)}/cdc", 503)  # refreshed, then the read fails
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 502
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200
    assert _connection(biz.id).status == "connected"
