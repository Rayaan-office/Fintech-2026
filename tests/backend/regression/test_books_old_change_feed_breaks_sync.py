"""After a month without reading QuickBooks (laptop closed, connection expired), every read failed.

QuickBooks only keeps 30 days of changes and refuses older starting points, but we always asked
for changes since the last read. Older starting points now read everything instead.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from tests.backend.integration.test_accounting_software import _connect, _connection, biz, fake_qbo  # noqa: F401

from app.db import tenant_session
from app.models import Connection


def test_month_old_read_reads_everything(biz, fake_qbo):  # noqa: F811
    _connect(biz, fake_qbo)
    with tenant_session(biz.id) as db:
        c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one()
        c.meta = {**c.meta, "cdc_since": (datetime.now(UTC) - timedelta(days=31)).isoformat(timespec="seconds")}
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200
    assert _connection(biz.id).meta["last_read"] == "full"
