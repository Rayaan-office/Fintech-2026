"""The fixed rules behind getting paid: how a payment was made, what counts as arriving short,
reminder timing, card fees and which payment links may go into an email."""

from datetime import date, timedelta

import pytest

from app.analytics import getting_paid, matching, methods
from app.connectors import payment_links
from app.models import Record

DAY = date(2026, 9, 1)


@pytest.mark.parametrize("text,currency,channel,expected", [
    ("INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9001", "GBP", None, "international_transfer"),
    ("FX CREDIT KOFFIE BV", "GBP", None, "international_transfer"),
    ("KOFFIE BV INV-9001", "EUR", None, "international_transfer"),  # another currency
    ("STRIPE PAYMENTS UK PAYOUT 0025", "GBP", None, "card"),
    ("CASH DEPOSIT LEEDS BRANCH", "GBP", None, "cash"),
    ("COUNTER CREDIT 4417", "GBP", None, "cash"),
    ("CLOUDDESK SOFTWARE CARD", "GBP", None, "card"),
    ("TESCO STORES 2231", "GBP", "in store", "card"),
    ("CORNER DELI REF INV-2053", "GBP", "other", "bank_transfer"),
    ("BRIGHT CAFE FPS INV-2049", "GBP", None, "bank_transfer"),
])
def test_bank_payment_method(text, currency, channel, expected):
    assert methods.from_bank(text, currency, "GBP", channel) == expected


def test_words_are_matched_whole():
    # "fx" inside a word, or "intl" inside a name, is not an international transfer
    assert methods.from_bank("EFFXON LTD REF 12", "GBP", "GBP") == "bank_transfer"
    assert methods.from_bank("PRINTLAB LTD", "GBP", "GBP") == "bank_transfer"


@pytest.mark.parametrize("details,expected", [
    ({"type": "card", "card": {"country": "NL", "brand": "visa"}}, ("card", "NL")),
    ({"type": "card", "card": {"country": None}}, ("card", None)),
    ({"type": "bacs_debit", "bacs_debit": {}}, ("bank_transfer", None)),
    ({"type": "customer_balance"}, ("bank_transfer", None)),
    (None, ("card", None)),  # a charge is a card payment unless it says otherwise
])
def test_stripe_payment_method(details, expected):
    assert methods.from_stripe(details) == expected


def test_older_records_get_a_method_from_their_text():
    r = Record(kind="bank_txn", source="plaid", currency="GBP", description="SWIFT ROTTERDAM BAKERY", method=None)
    assert methods.of(r) == "international_transfer"
    assert methods.of(Record(kind="payment_in", source="stripe", currency="GBP", method=None)) == "card"
    r.method = "cash"
    assert methods.of(r) == "cash"


def test_an_international_transfer_may_lose_a_fixed_charge():
    # 3% + 50p of £400.00 is £12.50: a £18.60 charge is too much for a card platform's fee...
    assert not matching._fee_ok(40_000, 40_000 - 18_60)
    # ...but international transfers often lose a fixed charge of that size on the way
    assert matching._fee_ok(40_000, 40_000 - 18_60, international=True)
    assert matching._fee_ok(40_000, 40_000 - 30_00, international=True)
    assert not matching._fee_ok(40_000, 40_000 - 30_01, international=True)  # at most £30
    assert not matching._fee_ok(100_00, 100_00 - 15_00, international=True)  # and at most 10%
    assert matching._fee_ok(1_000_00, 1_000_00 - 30_50, international=True)  # 3% + 50p is still allowed


def _candidate(invoice: int, paid: int, rule="invoice_number", kind="invoice", text="SWIFT REF INV-1"):
    t = Record(kind=kind, amount_minor=invoice, open_minor=invoice, currency="GBP")
    p = Record(kind="bank_txn", amount_minor=paid, currency="GBP", description=text, method=None)
    return matching.Candidate(t, p, 100, rule, {}, min(invoice, paid))


def test_what_arrived_short_is_recorded_only_within_the_allowance():
    assert matching.short_by(_candidate(40_000, 38_140)) == 1_860
    assert matching.short_by(_candidate(40_000, 40_000)) == 0
    assert matching.short_by(_candidate(40_000, 30_000)) == 0  # a part payment, not a charge
    assert matching.short_by(_candidate(40_000, 38_140, kind="bill")) == 0  # only money coming in
    assert matching.short_by(_candidate(40_000, 38_140, rule="combination")) == 0


def test_reminder_stages_and_their_timing():
    due = DAY
    assert getting_paid.next_stage(due, {}) == (1, due + timedelta(days=1))  # once overdue
    assert getting_paid.next_stage(due, {1: DAY + timedelta(days=3)}) == (2, DAY + timedelta(days=10))
    assert getting_paid.next_stage(due, {1: DAY, 2: DAY + timedelta(days=8)}) == (3, DAY + timedelta(days=22))
    assert getting_paid.next_stage(due, {1: DAY, 2: DAY, 3: DAY}) is None  # nothing after the final notice


def test_card_fee_at_a_stated_rate():
    rate = {"rate": 0.015, "fixed_minor": 20}
    assert getting_paid.card_fee(rate, [40_000, 10_000]) == (600 + 20) + (150 + 20)
    assert getting_paid.TYPICAL_CARD == (0.015, 20) and getting_paid.TYPICAL_CARD_ABROAD == (0.0325, 20)


@pytest.mark.parametrize("url,ok", [
    ("https://buy.stripe.com/test_abc123", True),
    ("https://invoice.stripe.com/i/acct_1/test_xyz", True),
    ("http://buy.stripe.com/test_abc123", False),
    ("https://buy.stripe.com.evil.example/test", False),
    ("https://evil.example/?u=https://buy.stripe.com/x", False),
    ("javascript:alert(1)", False),
    (None, False),
])
def test_only_stripe_payment_pages_go_into_an_email(url, ok):
    assert (payment_links.safe_url(url) is not None) is ok
