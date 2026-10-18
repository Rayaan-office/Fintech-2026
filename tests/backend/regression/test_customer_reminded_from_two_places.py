"""Bug: with reminders in three steps, a slow-paying customer with overdue invoices was offered a
reminder from two cards (the slow payer's and the reminder's), so the same invoices could be
chased twice and the steps lost count. Now only the reminder card chases; and approving a second
copy of a reminder step already sent for those invoices is refused."""

from datetime import date, timedelta

import pytest
from sqlalchemy import select
from tests.backend import getting_paid_books, story_books

from app import actions
from app.analytics import rules
from app.config import get_settings
from app.connectors import email_out
from app.db import tenant_session
from app.models import Reminder

TODAY = date.today()


@pytest.fixture(autouse=True)
def _no_links_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_links_key", None)


def test_only_the_reminder_card_chases_a_slow_payer(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", "Bright Cafe")
        for weeks_ago in range(20, 4, -2):
            issued = TODAY - timedelta(weeks=weeks_ago)
            story_books.record(db, bid, "invoice", 400_00, issued, counterparty_id=cp.id, status="paid", open_minor=0,
                               due_date=issued + timedelta(days=14), paid_date=issued + timedelta(days=26))
        story_books.record(db, bid, "invoice", 300_00, TODAY - timedelta(days=20), counterparty_id=cp.id,
                           due_date=TODAY - timedelta(days=6))
        found = {f.kind: f for f in rules.find_all(db, TODAY)}
    assert found["slow_payer"].next_step["action"] is None
    assert found["chase_overdue"].next_step["action"] == "send_payment_reminder"


def test_the_same_step_is_never_sent_twice(businesses, sign_in, monkeypatch):
    sent = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append(body) or "<id@x>")
    shop = getting_paid_books.short_paid_business()
    payload = {"counterparty_id": str(shop.ids.cp), "subject": "Payment reminder", "body": "Please pay.",
               "stage": 1, "record_ids": [str(shop.ids.late)]}
    with tenant_session(shop.id) as db:
        first, second = (actions.propose(db, shop.id, "send_payment_reminder", requested_by="ai:test",
                                         summary="Reminder", payload=payload).id for _ in range(2))
    c = sign_in(f"books@{shop.tag}.test")
    assert c.post(f"/api/actions/{first}/approve").json()["status"] == "executed"
    r = c.post(f"/api/actions/{second}/approve")
    assert r.status_code == 409 and "already sent this reminder" in r.json()["detail"]
    assert len(sent) == 1
    with tenant_session(shop.id) as db:
        assert [x.stage for x in db.execute(select(Reminder)).scalars()] == [1]
