"""Bug, found in the live check: asked "how much did we spend on each category this year?", the query
tool counted £41,100 moved between the business's own accounts as spending, and wrote "1 payments
out". Money in and out now leave such transfers out (unless asked for by category), and say so."""

from datetime import date, timedelta

from tests.backend import story_books

from app.copilot import tools
from app.db import read_only_session, tenant_session

TODAY = date.today()


def test_own_transfers_are_not_spending_and_one_payment_is_singular(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        story_books.record(db, bid, "bank_txn", 41_100_00, TODAY - timedelta(days=3), category="transfer")
        story_books.record(db, bid, "bank_txn", 120_00, TODAY - timedelta(days=2), category="utilities")
    with read_only_session(bid) as db:
        res = tools.query_records(db, TODAY, kind="money_out", group_by="category")
        asked = tools.query_records(db, TODAY, kind="money_out", category="transfer")
    assert res.facts["all together"] == "all together: £120.00 from 1 payment out"
    assert res.facts["by category"] == ["utilities: £120.00 from 1 payment out"]
    assert res.facts["left out"] == "transfers between the business's own accounts"
    assert asked.facts["all together"] == "all together: £41,100.00 from 1 payment out"
