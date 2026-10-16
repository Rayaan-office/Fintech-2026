"""The activity log detects edits."""

import pytest
from sqlalchemy import text

from app import bootstrap
from app.db import tenant_session
from app.security import audit


def test_chain_is_intact_then_detects_tampering(businesses):
    bid = businesses["b"]
    with tenant_session(bid) as db:
        audit.record(db, bid, "user:test", "match_accepted", details={"amount_minor": 1200})
        audit.record(db, bid, "user:test", "bill_recorded", details={"amount_minor": 5000})
    with tenant_session(bid) as db:
        assert audit.verify_chain(db, bid)["intact"]
    # Simulate someone with database admin rights editing an old entry
    with bootstrap._engine_for().connect() as c:
        c.execute(text("UPDATE audit_log SET details = '{\"amount_minor\": 1}' "
                       "WHERE event = 'match_accepted' AND business_id = :b"), {"b": str(bid)})
    with tenant_session(bid) as db:
        result = audit.verify_chain(db, bid)
    assert result["intact"] is False


def test_document_text_cannot_enter_the_log(businesses):
    with pytest.raises(ValueError):
        with tenant_session(businesses["a"]) as db:
            audit.record(db, businesses["a"], "system", "oops", details={"text": "Invoice for Jane Smith"})
