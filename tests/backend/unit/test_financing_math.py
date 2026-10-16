"""How financing cost, repayments, the need and the effect on the forecast are worked out."""

from datetime import date, timedelta

import pytest

from app.analytics import financing

START = date(2026, 11, 1)
VALUES = {"months_trading": 12, "monthly_sales_minor": 10_000_00, "card_share": 0.3,
          "card_sales_monthly_minor": 4_000_00, "unpaid_invoices_minor": 8_000_00, "days_to_get_paid": 30,
          "country": "GB", "credit_band": "good", "business_type": "limited_company"}


def _p(**kw):
    base = {"id": "x", "type": "term_loan", "min_minor": 100_00, "max_minor": 100_000_00, "min_months": 1,
            "max_months": 60, "rate_min": 0.12, "rate_max": 0.12, "fee_pct": 0, "fee_minor": 0, "rules": {}}
    return base | kw


def test_term_loan_uses_the_standard_monthly_repayment():
    q = financing.quote(_p(), 10_000_00, 12, VALUES, START)
    assert q["monthly_repayment_minor"] == 888_49  # £10,000 at 12% a year over 12 months
    assert q["total_cost_minor"] == round(888_48.79 * 12 - 10_000_00)
    assert q["flows"][0] == (START, 10_000_00) and len(q["flows"]) == 13


def test_fees_are_part_of_the_cost_and_come_off_the_money_in():
    q = financing.quote(_p(fee_pct=0.02), 10_000_00, 12, VALUES, START)
    assert q["fee_minor"] == 200_00 and q["flows"][0] == (START, 9_800_00)
    assert q["total_cost_minor"] == financing.quote(_p(), 10_000_00, 12, VALUES, START)["total_cost_minor"] + 200_00


def test_line_of_credit_charges_interest_only_on_what_is_used():
    q = financing.quote(_p(type="credit_line", rate_min=0.1825, rate_max=0.1825), 3_650_00, 2, VALUES, START)
    assert q["total_cost_minor"] == round(3_650_00 * 0.1825 * 60 / 365)  # £109.50 for 60 days
    assert q["flows"][-1] == (date(2027, 1, 1), -3_650_00)  # the amount itself is repaid at the end


def test_invoice_finance_fee_runs_until_customers_pay():
    q = financing.quote(_p(type="invoice_finance", rate_min=0.02, rate_max=0.02, advance=0.8), 4_000_00, 1,
                        VALUES, START)
    assert q["total_cost_minor"] == 100_00  # 2% a month of £5,000 of invoices for one month
    assert q["flows"] == [(START, 4_000_00), (START + timedelta(days=30), -4_100_00)]


def test_card_advance_is_repaid_from_card_sales_and_shows_its_yearly_cost():
    q = financing.quote(_p(type="merchant_cash_advance", rate_min=1.2, rate_max=1.2, share_of_card_sales=0.12),
                        2_000_00, 1, VALUES, START)
    assert q["total_cost_minor"] == 400_00
    assert sum(a for _, a in q["flows"][1:]) == -2_400_00
    weekly = round(4_000_00 * 12 / 52 * 0.12)  # 12% of about £923 of card sales a week
    weeks = -(-2_400_00 // weekly)
    assert len(q["flows"]) == 1 + weeks
    assert q["yearly_cost_pct"] == round(400_00 / 2_000_00 / (weeks / 52) * 100, 1)  # 47.3%, against 20% upfront


def _series(values, start=START):
    return {"safety_level_minor": 1_000_00, "series": [
        {"date": (start + timedelta(days=i)).isoformat(), "expected_minor": v} for i, v in enumerate(values)]}


def test_the_gap_is_the_safety_level_minus_the_lowest_point_with_a_margin():
    fc = _series([2_000_00, 1_500_00, 900_00, 400_00, 700_00, 1_100_00, 1_200_00])
    g = financing.gap(fc)
    assert g["amount_minor"] == 700_00 and g["starts_on"]  # £600 missing, plus 5%, rounded up to £100 == "2026-11-03" and g["ends_on"] == "2026-11-06"
    assert financing.gap(_series([2_000_00, 1_500_00])) is None


def test_the_effect_adds_money_in_and_repayments_to_every_day_after():
    fc = _series([2_000_00, 900_00, 800_00, 1_200_00, 1_300_00])
    e = financing.effect(fc, [(START + timedelta(days=1), 500_00), (START + timedelta(days=3), -500_00)])
    assert [p["expected_minor"] for p in e["series"]] == [2_000_00, 1_400_00, 1_300_00, 1_200_00, 1_300_00]
    assert e["closes_gap"] and "stays above your safety level" in e["forecast_effect"]


@pytest.mark.parametrize("rules, note", [
    ({"min_months_trading": 24}, "Available after 12 more months of trading."),
    ({"min_card_share": 0.5}, "Needs at least 50% of sales paid by card."),
    ({"business_types": ["sole_trader"]}, "Not offered to your type of business."),
    ({"min_credit_band": "excellent"}, "Usually needs a excellent or better credit history."),
])
def test_near_misses_say_why(rules, note):
    ok, why = financing.eligibility(_p(rules=rules), VALUES, 0)
    assert not ok and why == [note]


def test_choices_accept_labels():
    assert financing.choice("Limited company", financing.BUSINESS_TYPES) == "limited_company"
    assert financing.choice("Good", financing.CREDIT_BANDS) == "good"
    assert financing.choice("Superb", financing.CREDIT_BANDS) is None
