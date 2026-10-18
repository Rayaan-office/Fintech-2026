"""Bug: the options list timed the money to arrive the day before cash dips, but the detail panel
(the sliders) started it tomorrow. An overdraft's repayment then fell inside the dip, so the list
said "Covers it" while its own panel showed cash dropping below the safety level."""

from datetime import date

import pytest
from tests.backend import story_books

from app.analytics import financing, forecast
from app.db import tenant_session
from app.models import Business

TODAY = date.today()


@pytest.fixture(scope="module")
def bid(businesses):
    bid, *_ = story_books.story_business()
    with tenant_session(bid) as db:
        low = forecast.build(db, TODAY)["lowest"]["balance_minor"]
        db.get(Business, bid).safety_level_minor = low + 3_000_00  # a dip to close
    return bid


def test_every_option_in_the_list_gets_the_same_answer_in_its_panel(bid):
    with tenant_session(bid) as db:
        found = financing.options(db, TODAY)
        assert found["gap"]
        quoted = [o for o in found["options"] if o.get("quote")]
        assert any(o["type"] == "credit_line" for o in quoted)
        for o in quoted:
            q = o["quote"]
            one = financing.quote_one(db, o["id"], q["amount_minor"], q["months"], TODAY)
            assert one["closes_gap"] == q["closes_gap"], o["id"]
            assert one["forecast_effect"] == q["forecast_effect"], o["id"]
            assert one["arrives_on"] == q["arrives_on"] < found["gap"]["starts_on"]
