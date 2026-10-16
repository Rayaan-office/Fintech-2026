"""Our Stripe connector still understands the real sandbox (run with --live, after
`uv run python -m app.demo.payments` has filled it)."""

import pytest

from app.connectors import outbound, stripe_conn

pytestmark = pytest.mark.live

LISTS = [("customers", stripe_conn.Customer, {}), ("invoices", stripe_conn.Invoice, {}),
         ("invoice_payments", stripe_conn.InvoicePayment, {}),
         ("charges", stripe_conn.Charge, {"expand[]": "data.balance_transaction"}),
         ("refunds", stripe_conn.Refund, {}), ("disputes", stripe_conn.Dispute, {}),
         ("payouts", stripe_conn.Payout, {})]


@pytest.mark.parametrize("path,model,params", LISTS, ids=[p for p, *_ in LISTS])
def test_every_object_fits_our_shape(path, model, params):
    skipped: list = []
    items = list(stripe_conn._list(path, model, params, skipped=skipped))
    assert skipped == []
    if path != "payouts":  # a new sandbox may not have paid out yet
        assert items, f"the sandbox has no {path}; run app.demo.payments"


def test_card_payments_carry_their_fee():
    charges = [c for c in stripe_conn._list("charges", stripe_conn.Charge, {"expand[]": "data.balance_transaction"})
               if c.status == "succeeded"]
    assert charges and all(isinstance(c.balance_transaction, dict) for c in charges)
    assert {c.balance_transaction["currency"] for c in charges} == {"gbp"}


def test_balance_is_in_pounds():
    bal = stripe_conn._get("balance")
    assert bal["livemode"] is False and {b["currency"] for b in bal["available"]} == {"gbp"}


def test_our_key_cannot_change_anything():
    with outbound.client() as http:
        r = http.post(f"{stripe_conn.API}/customers", data={"name": "should not exist"},
                      auth=(stripe_conn._key(), ""), headers={"Stripe-Version": stripe_conn.API_VERSION})
    assert r.status_code in (401, 403)
