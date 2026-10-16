"""The Stripe demo data: the same each run, the size of one weekly payout, and sandbox-only."""

import pytest
from pydantic import SecretStr

from app.demo import payments


def test_the_week_of_card_sales_is_the_same_every_run():
    assert payments.sales() == payments.sales()


def test_card_sales_add_up_to_one_weekly_payout():
    ok = [s for s in payments.sales() if s["card"] not in ("pm_card_visa_chargeDeclined", "pm_card_createDispute")]
    assert 780_00 <= sum(s["amount"] for s in ok) <= 1_400_00


def test_card_sales_include_the_awkward_cases():
    plan = payments.sales()
    assert len({s["key"] for s in plan}) == len(plan)
    assert sum(1 for s in plan if s.get("refund")) == 1
    assert {"sale-declined", "sale-disputed"} <= {s["key"] for s in plan}


@pytest.mark.parametrize("key", ["sk_live_real", "rk_live_real", "pk_test_public", ""])
def test_seeding_refuses_anything_but_a_sandbox_key(monkeypatch, key):
    monkeypatch.setattr(payments._s, "stripe_seed_key", SecretStr(key))
    with pytest.raises(payments.SeedError):
        payments.Stripe()


def test_seeding_refuses_a_sandbox_outside_the_uk(monkeypatch):
    monkeypatch.setattr(payments._s, "stripe_seed_key", SecretStr("sk_test_fake"))
    api = payments.Stripe()
    monkeypatch.setattr(api, "call", lambda *a, **k: {"country": "AE"})
    with pytest.raises(payments.SeedError, match="not the UK"):
        payments.check_account(api)
