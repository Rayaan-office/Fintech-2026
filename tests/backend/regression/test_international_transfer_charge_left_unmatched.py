"""Bug: a customer abroad paid a £400.00 invoice by international transfer, naming it, and £381.40
arrived: the banks on the way took £18.60. We allowed only 3% + 50p (£12.50) for fees, so the
payment was never matched and the invoice looked unpaid. International transfers lose a fixed
charge instead, so for one we now allow up to £30 (at most 10%), and record what arrived short."""

from datetime import date, timedelta

from sqlalchemy import select
from tests.backend import getting_paid_books, story_books

from app.db import tenant_session
from app.models import Match

TODAY = date.today()


def _pay(text: str, short: int) -> dict:
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", "Rotterdam Bakery BV")
        story_books.record(db, bid, "invoice", 400_00, TODAY - timedelta(days=40), counterparty_id=cp.id,
                           due_date=TODAY - timedelta(days=10), reference="INV-9001")
        story_books.record(db, bid, "bank_txn", 400_00 - short, TODAY - timedelta(days=8), direction="in",
                           description=text)
        out = getting_paid_books.match(db, bid)
        m = db.execute(select(Match)).scalar_one_or_none()
        return {"out": out, "rule": m.rule if m else None, "signals": m.signals if m else None}


def test_an_international_transfer_less_its_charge_is_matched(businesses):
    got = _pay("INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9001", 18_60)
    assert got["out"]["auto"] == 1 and got["rule"] == "invoice_number"
    assert got["signals"]["short_minor"] == 18_60


def test_a_domestic_payment_keeps_the_usual_allowance(businesses):
    got = _pay("ROTTERDAM BAKERY BV REF INV-9001", 18_60)
    assert got["rule"] != "invoice_number" and got["out"]["auto"] == 0  # a person decides


def test_far_too_little_is_still_not_a_bank_charge(businesses):
    got = _pay("INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9001", 60_00)
    assert got["out"]["auto"] == 0 and not (got["signals"] or {}).get("short_minor")
