"""One business must never see another's data, even if our code forgets a filter."""

from datetime import date

from sqlalchemy import select, text

from app.db import AppSession, tenant_session
from app.models import Record


def _add_record(bid, ref):
    with tenant_session(bid) as db:
        db.add(Record(business_id=bid, source="manual", source_ref=ref, kind="bill", direction="out",
                      amount_minor=1000, date=date.today()))


def test_rows_are_hidden_from_other_businesses(businesses):
    _add_record(businesses["a"], "iso-a")
    _add_record(businesses["b"], "iso-b")
    with tenant_session(businesses["a"]) as db:
        refs = set(db.execute(select(Record.source_ref)).scalars())
    assert "iso-a" in refs and "iso-b" not in refs


def test_no_business_set_means_no_rows(businesses):
    _add_record(businesses["a"], "iso-none")
    with AppSession() as db:
        assert db.execute(select(Record)).first() is None


def test_cannot_write_into_another_business(businesses):
    import pytest
    from sqlalchemy.exc import ProgrammingError

    with pytest.raises(ProgrammingError):
        with tenant_session(businesses["a"]) as db:
            db.add(Record(business_id=businesses["b"], source="manual", source_ref="sneaky", kind="bill",
                          direction="out", amount_minor=1, date=date.today()))


def test_app_account_cannot_read_the_vault(businesses):
    import pytest
    from sqlalchemy.exc import ProgrammingError

    with pytest.raises(ProgrammingError):
        with tenant_session(businesses["a"]) as db:
            db.execute(text("SELECT * FROM vault.pii_values"))


def test_app_account_cannot_edit_the_activity_log(businesses):
    import pytest
    from sqlalchemy.exc import ProgrammingError

    with pytest.raises(ProgrammingError):
        with tenant_session(businesses["a"]) as db:
            db.execute(text("UPDATE audit_log SET actor = 'someone-else'"))
