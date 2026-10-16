"""Bug: CloudDesk's subscription rose every month (£59 to £74 before VAT) but was not raised,
because we asked for at least £30 a month more. A small charge creeping up is what this
recommendation is for; the floor is now £10 a month."""

from datetime import date

from tests.backend import story_books

from app.analytics import forecast, rules
from app.db import tenant_session

TODAY = date.today()


def test_small_creeping_subscription_is_raised(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "supplier", "CloudDesk Software Ltd")
        for i, net in zip((4, 3, 2, 1), (59_00, 64_00, 69_00, 74_00), strict=True):
            story_books.record(db, bid, "bill", round(net * 1.2), forecast.add_months(TODAY.replace(day=1), -i),
                               counterparty_id=cp.id, category="software subscriptions", tax_minor=round(net * 0.2),
                               status="paid", open_minor=0)
        found = rules.spending_creep(db, TODAY, skip=set())
    assert [(f.kind, f.facts["mostly from"]) for f in found] == [("spending_creep", "CloudDesk Software Ltd")]
