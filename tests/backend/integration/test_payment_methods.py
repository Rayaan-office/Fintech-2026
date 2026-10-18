"""The connectors keep how each payment was made: Stripe card payments (with the card's country),
bank lines from their channel and text, and the Stripe invoice's own payment page."""

import copy

import pytest
from sqlalchemy import select
from tests.backend.integration.test_bank_account import FakePlaid, _connect
from tests.backend.integration.test_payment_platform import sandbox

from app.connectors import plaid_conn, stripe_conn
from app.db import tenant_session
from app.models import Record
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people


@pytest.fixture
def stripe_biz(businesses, monkeypatch):
    data = sandbox()
    charges = data["charges"]["data"]
    charges[0]["payment_method_details"] = {"type": "card", "card": {"brand": "visa", "country": "NL"}}
    charges[1]["payment_method_details"] = {"type": "bacs_debit", "bacs_debit": {}}
    data["invoices"]["data"][1]["hosted_invoice_url"] = "https://invoice.stripe.com/i/acct_test/test_open"
    data["invoices"]["data"][0]["hosted_invoice_url"] = "https://evil.example/pay"
    monkeypatch.setattr(stripe_conn, "_get", lambda path, params=None: copy.deepcopy(data[path]))
    b = create_business("Business PM", people("pm"), {e: PASSWORD for e, *_ in people("pm")}, inbox="bills@pm.test")
    return b.id


def _stripe_records(bid) -> dict:
    with tenant_session(bid) as db:
        rows = db.execute(select(Record).where(Record.source == "stripe")).scalars().all()
        db.expunge_all()
    return {r.source_ref: r for r in rows}


def test_stripe_payments_keep_their_method_and_card_country(stripe_biz):
    bid = stripe_biz
    with tenant_session(bid) as db:  # a sync, without taking the one Stripe sandbox from other tests
        stripe_conn.sync(db, bid)
    recs = _stripe_records(bid)
    assert (recs["ch_invoice"].method, recs["ch_invoice"].external["card_country"]) == ("card", "NL")
    assert (recs["ch_counter"].method, recs["ch_counter"].external["card_country"]) == ("bank_transfer", None)
    assert recs["ch_disputed"].method == "card"  # no details: a card payment
    # Stripe's own page for paying an open invoice is kept; any other address is not
    assert recs["in_open"].external["hosted_invoice_url"] == "https://invoice.stripe.com/i/acct_test/test_open"
    assert recs["in_paid"].external["hosted_invoice_url"] is None


@pytest.fixture
def plaid_biz(businesses, sign_in, monkeypatch):
    fake = FakePlaid()
    real = fake.txn

    def txn(item, key, **over):
        extra = {"k1": {"name": "INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-2001", "payment_channel": "other"},
                 "k3": {"payment_channel": "in store"}}.get(key, {})
        return real(item, key, **{**extra, **over})

    fake.txn = txn
    monkeypatch.setattr(plaid_conn, "_post", fake)
    b = create_business("Business PB", people("pb"), {e: PASSWORD for e, *_ in people("pb")}, inbox="bills@pb.test")

    class Biz:
        id = b.id
        finance = sign_in("finance@pb.test")
        plaid = fake
    return Biz


def test_bank_lines_keep_their_method(plaid_biz):
    _connect(plaid_biz)
    plaid_biz.plaid.item["released"] = 2  # the rest of the history is ready
    assert plaid_biz.finance.post("/api/connections/plaid/sync").status_code == 200
    with tenant_session(plaid_biz.id) as db:
        got = {r.description: (r.method, r.external.get("channel")) for r in db.execute(
            select(Record).where(Record.source == "plaid")).scalars()}
    assert got["INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-2001"] == ("international_transfer", "other")
    assert got["SHELL FUEL"] == ("card", "in store")
    assert got["MILL PROPERTIES RENT"][0] == "bank_transfer"
    assert got["STRIPE PAYMENTS UK PAYOUT 0025"][0] == "card"  # card sales paid out by the platform
