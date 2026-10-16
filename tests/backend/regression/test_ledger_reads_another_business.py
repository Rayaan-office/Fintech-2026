"""The ledger could read the wrong business's settings.

Cash, forecast and health read "the business" as the first row of the businesses table,
which need not be the one signed in: another business's currency and safety level could
be used. They now read the business the session belongs to.
"""

from tests.backend import story_books

from app.analytics import ledger
from app.db import global_session, tenant_session
from app.models import Business


def test_each_session_reads_its_own_business(businesses):
    first, _ = story_books.new_business()
    second, _ = story_books.new_business()
    with global_session() as db:
        db.get(Business, first).currency = "EUR"
    with tenant_session(second) as db:
        assert ledger.business(db).id == second
        assert ledger.cash(db)["currency"] == "GBP"
    with tenant_session(first) as db:
        assert ledger.business(db).id == first
