"""Money that will never arrive was counted as on its way.

The drafted connector recorded failed or cancelled payouts as "pending", and invoices Stripe
marks uncollectible (written off) as "open", so the cash forecast would have expected both.
"""

import copy

from sqlalchemy import select

from app.connectors import stripe_conn
from app.db import tenant_session
from app.models import Record
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people
from tests.backend.integration.test_payment_platform import sandbox


def test_failed_payouts_and_written_off_invoices_are_void(businesses, monkeypatch):
    data = sandbox()
    data["payouts"]["data"][0]["status"] = "failed"
    data["invoices"]["data"][1]["status"] = "uncollectible"
    monkeypatch.setattr(stripe_conn, "_get", lambda path, params=None: copy.deepcopy(data[path]))
    b = create_business("Business R2", people("r2"), {e: PASSWORD for e, *_ in people("r2")}, inbox="bills@r2.test")
    with tenant_session(b.id) as db:
        stripe_conn.sync(db, b.id)
    with tenant_session(b.id) as db:
        recs = {r.source_ref: r for r in db.execute(select(Record)).scalars()}
    assert recs["po_1"].status == "void"
    assert (recs["in_open"].status, recs["in_open"].open_minor) == ("void", 0)
