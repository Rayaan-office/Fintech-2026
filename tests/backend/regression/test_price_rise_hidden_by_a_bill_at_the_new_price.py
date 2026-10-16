"""Bug: Acme's flour price rise was missed on the demo company. We work out the usual price per
unit from past line amounts (7, 8 or 9 bags at £45.00), but one past bill already at the new
price (8 bags at £53.10) made every amount share only £1.80, so no usual price was found."""

from datetime import date, timedelta

from tests.backend import story_books

from app.analytics import rules
from app.db import tenant_session

TODAY = date.today()


def test_usual_unit_price_survives_one_bill_at_the_new_price(businesses):
    assert rules._usual_unit([31500, 36000, 40500, 36000, 42480]) == 4500


def test_flour_rise_found_with_a_new_price_bill_in_the_history(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "supplier", "Acme Supplies Ltd")
        for i, bags in enumerate([7, 8, 9, 8, 7, 9]):
            story_books.record(db, bid, "bill", bags * 4500, TODAY - timedelta(days=80 - i * 7), counterparty_id=cp.id,
                               lines=[{"description": "Strong white flour 25kg", "amount_minor": bags * 4500}])
        story_books.record(db, bid, "bill", 8 * 5310, TODAY - timedelta(days=10), counterparty_id=cp.id,
                           lines=[{"description": "Strong white flour 25kg", "amount_minor": 8 * 5310}])
        story_books.record(db, bid, "bill", 8 * 5310, TODAY - timedelta(days=3), counterparty_id=cp.id, source="document",
                           lines=[{"description": "Strong white flour 25kg", "amount_minor": 8 * 5310,
                                   "quantity": "8", "unit_price_minor": 5310}])
        found = rules.price_rises(db, TODAY)
    flour = found[0].facts["price changes on lines"][0]
    assert (flour["usual price"], flour["now"], flour["rise"]) == ("£45.00", "£53.10", "18%")
