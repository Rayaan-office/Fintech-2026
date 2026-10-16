"""Bug: the profile had been saved with labels ("Good", "Limited company") instead of codes, and
financing matching crashed looking up "Good" in the credit bands."""

from tests.backend import story_books

from app.analytics import financing
from app.db import tenant_session
from app.models import BusinessProfile


def test_labels_in_a_saved_profile_still_match(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        row = db.get(BusinessProfile, bid)
        row.owner_fields = {**row.owner_fields, "credit_band": "Good", "business_type": "Limited company"}
    with tenant_session(bid) as db:
        o = financing.options(db, amount=5_000_00, months=12)
    values = o["profile"]["values"]
    assert values["credit_band"] == "good" and values["business_type"] == "limited_company"
    assert o["options"]
