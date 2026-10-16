"""Connecting a different QuickBooks company mixed its books with the first one's.

Records were keyed by QuickBooks' own ids ("Invoice:101"), which every company reuses, so the
new company's invoices overwrote unrelated ones and the rest stayed as if still current. Keys
now include the company, and switching company voids the old company's records.
"""

from sqlalchemy import select
from tests.backend.integration.test_accounting_software import _connect, _realm, biz, fake_qbo  # noqa: F401

from app.db import tenant_session
from app.models import Record


def test_switching_company_keeps_books_apart(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    first = _realm(biz.id)
    _connect(biz, fake_qbo)
    second = _realm(biz.id)
    with tenant_session(biz.id) as db:
        rows = db.execute(select(Record).where(Record.source == "quickbooks")).scalars().all()
    assert len(rows) == 10
    assert {r.status for r in rows if r.source_ref.startswith(first)} == {"void"}
    assert "void" not in {r.status for r in rows if r.source_ref.startswith(second)}
