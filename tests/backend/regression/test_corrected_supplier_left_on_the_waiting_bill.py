"""Correcting the supplier on a bill waiting for approval left the bill with the wrong supplier.

The new name was saved on the document, but the waiting approval still carried the supplier the
AI had read, so approving it recorded the bill against that supplier. The waiting approval is
now replaced with one for the corrected supplier.
"""

from sqlalchemy import select
from tests.backend.learning_steps import approve, bill, correct, fresh_business, read, waiting

import app.handlers  # noqa: F401  (registers approval handlers)
from app.db import tenant_session
from app.models import Counterparty, Record


def test_the_bill_is_recorded_against_the_corrected_supplier(businesses, fake_ai, sign_in):
    biz = fresh_business()
    c = sign_in(f"books@{biz['tag']}.test")
    did = read(biz["id"], fake_ai, bill("WS-1"))
    correct(c, did, counterparty_name="Packaging Direct Ltd")
    [a] = waiting(c, did)
    assert "Packaging Direct Ltd" in a["summary"]
    approve(c, did)
    with tenant_session(biz["id"]) as db:
        rec = db.execute(select(Record).where(Record.reference == "WS-1")).scalar_one()
        assert db.get(Counterparty, rec.counterparty_id).display_name == "Packaging Direct Ltd"
