"""A what-if cost moved the forecast by a penny more or less than its amount.

The everyday pattern was kept in fractions of a penny and each day was rounded on its own,
so a £20,000 van could move the line by £19,999.99. The pattern is now in whole pence.
"""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import forecast
from app.db import tenant_session


def test_van_moves_the_line_by_exactly_its_price(businesses):
    bid, *_ = story_books.story_business()
    today = date.today()
    with tenant_session(bid) as db:
        base = forecast.build(db, today)
        van = forecast.build(db, today, planned=[{"label": "Van", "amount_minor": 20_000_00,
                                                  "date": today + timedelta(days=5)}])
    diffs = {b["expected_minor"] - v["expected_minor"] for b, v in zip(base["series"][5:], van["series"][5:],
                                                                         strict=True)}
    assert diffs == {20_000_00}
