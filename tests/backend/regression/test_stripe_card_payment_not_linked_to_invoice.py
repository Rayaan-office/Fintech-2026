"""Card payments for Stripe invoices were never linked to the invoice, and invoice VAT was lost.

The drafted connector read charge.invoice and invoice.tax. Stripe removed both from its API
(we now pin 2026-09-30); the link is in Stripe's invoice payments, and VAT is in total_taxes.
So matching never saw which invoice a card payment paid.
"""

import copy

from sqlalchemy import select

from app.connectors import stripe_conn
from app.db import tenant_session
from app.models import Record
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people
from tests.backend.integration.test_payment_platform import sandbox


def test_payment_is_linked_through_invoice_payments(businesses, monkeypatch):
    data = sandbox()
    assert all("invoice" not in c for c in data["charges"]["data"])  # as Stripe sends them now
    monkeypatch.setattr(stripe_conn, "_get", lambda path, params=None: copy.deepcopy(data[path]))
    b = create_business("Business R1", people("r1"), {e: PASSWORD for e, *_ in people("r1")}, inbox="bills@r1.test")
    with tenant_session(b.id) as db:
        stripe_conn.sync(db, b.id)
    with tenant_session(b.id) as db:
        recs = {r.source_ref: r for r in db.execute(select(Record)).scalars()}
        assert recs["ch_invoice"].external["invoice"] == "in_paid"
        assert recs["ch_invoice"].reference == "CAKE-0001"
        assert recs["in_paid"].tax_minor == 1700
