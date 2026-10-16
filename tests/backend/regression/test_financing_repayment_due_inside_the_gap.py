"""Bug: for a 30-day shortfall we priced options over one month from the day before it, so the
repayment fell a day before cash recovered, and we borrowed exactly the amount missing, so the
first interest payment took cash straight back below the level. No short option closed the gap."""

from datetime import date, timedelta

from app.analytics import financing

START = date(2026, 11, 1)


def test_the_term_reaches_past_the_end_of_the_gap():
    values = [10_000_00] + [5_000_00] * 30 + [12_000_00] * 10  # below a £8,000 level for 30 days
    fc = {"safety_level_minor": 8_000_00, "series": [
        {"date": (START + timedelta(days=i)).isoformat(), "expected_minor": v} for i, v in enumerate(values)]}
    g = financing.gap(fc)
    assert g["days"] == 30 and g["months"] == 2
    p = {"type": "credit_line", "rate_min": 0.1, "rate_max": 0.1, "fee_pct": 0, "fee_minor": 0}
    start = date.fromisoformat(g["starts_on"]) - timedelta(days=1)
    q = financing.quote(p, g["amount_minor"], g["months"], {}, start)
    assert financing.effect(fc, q["flows"])["closes_gap"]
