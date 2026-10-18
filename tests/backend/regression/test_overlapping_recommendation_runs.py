"""Bug, found by the browser journeys: on a new business, the run started after an upload and the run from
"Check now" both found the same new recommendations and both tried to add them, so one failed on the
unique fingerprint and "Check now" showed an error. Saving now takes a lock per business and looks again
for what the other run just added."""

from datetime import date

from sqlalchemy import func, select
from tests.backend import story_books

from app.copilot import insights
from app.db import tenant_session
from app.models import Recommendation


def test_a_second_run_saving_the_same_new_findings_updates_them(businesses):
    bid, _ = story_books.new_business()
    story_books.load(bid)
    state = insights._rank(insights._find({"business_id": str(bid), "today": date.today()}))
    state = insights._write({**state, "paused": True})  # the template wording; no AI needed
    assert state["to_write"] and all(rec_id is None for _, rec_id in state["to_write"])

    first = insights._save(state)["result"]  # the other run finishes first
    second = insights._save(state)["result"]  # then this one, which also saw nothing saved yet

    assert first["new"] == len(state["to_write"]) and second == {**second, "new": 0, "updated": first["new"]}
    with tenant_session(bid) as db:
        assert db.scalar(select(func.count()).select_from(Recommendation)) == first["new"]
