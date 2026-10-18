"""Bug, found in the live check: reminder cards were worded "Invoice 1011 from Benjamin Yeung" and
"1 days overdue", and a payment-cost card left out the customer's name. The facts now say who owes
whom, count one day as "1 day", and the AI is told to name the supplier or customer in the title."""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import rules
from app.copilot import insights
from app.db import tenant_session

TODAY = date.today()


def test_reminder_facts_say_the_customer_owes_you_and_count_one_day(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", "Corner Deli")
        story_books.record(db, bid, "invoice", 300_00, TODAY - timedelta(days=15), counterparty_id=cp.id,
                           due_date=TODAY - timedelta(days=1), reference="INV-2077")
        f = next(f for f in rules.find_all(db, TODAY) if f.kind == "chase_overdue")
    assert f.facts["who owes whom"] == "Corner Deli owes you for invoices you sent them"
    assert f.facts["invoices"] == [f"INV-2077: £300.00, due {(TODAY - timedelta(days=1)).strftime('%-d %B %Y')}, "
                                   "1 day overdue"]
    assert "to Corner Deli" in f.body and "from Corner Deli" not in f.body


def test_the_ai_is_told_to_name_the_party_and_which_way_money_flows():
    assert "the title names them" in insights.INSTRUCTIONS
    assert "A customer owes the business money" in insights.INSTRUCTIONS
