"""Bug: a table column named `date` hid Python's `date` type inside the model class,
so later columns (due_date, paid_date) were typed wrongly and SQLAlchemy warned.
Fix: annotate with `dt.date`."""

import datetime as dt

from app.models import Record


def test_due_and_paid_dates_are_date_columns():
    for col in ("date", "due_date", "paid_date"):
        assert Record.__table__.c[col].type.python_type is dt.date
