"""The next payment reminder could be due a day early.

A reminder's send time is stored in UTC, and we took its day in UTC, while "today" is the local
day. East of London, between midnight local time and midnight UTC, the two days differ, so a
reminder sent 6 days ago already counted as 7 and the second reminder was due a day early.
"""

import time
from datetime import UTC, date, datetime

import pytest

from app.analytics.getting_paid import sent_day


@pytest.fixture
def dubai(monkeypatch):
    monkeypatch.setenv("TZ", "Asia/Dubai")  # UTC+4
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def test_a_reminder_sent_late_in_the_utc_day_counts_on_the_local_day(dubai):
    # 21:00 UTC on 13 October is 01:00 on 14 October in Dubai
    assert sent_day(datetime(2026, 10, 13, 21, 0, tzinfo=UTC)) == date(2026, 10, 14)
    assert sent_day(datetime(2026, 10, 13, 12, 0, tzinfo=UTC)) == date(2026, 10, 13)
