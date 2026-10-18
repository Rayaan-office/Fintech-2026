"""Getting paid stays inside one business and inside its roles: only an owner approves a final
notice, only finance managers and owners record bank charges, and payment links use a sandbox
restricted key only, are made only after approval and point only at Stripe's own pages."""

from datetime import date, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from tests.backend import getting_paid_books, story_books

from app import actions
from app.analytics import getting_paid
from app.config import get_settings
from app.connectors import email_out, outbound, payment_links
from app.copilot import insights
from app.db import tenant_session
from app.models import Action, Record, Reminder

TODAY = date.today()


@pytest.fixture(autouse=True)
def _no_links_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_links_key", None)


@pytest.fixture
def two(businesses, sign_in, monkeypatch):
    sent: list = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append(body) or "<id@x>")
    a, b = getting_paid_books.short_paid_business(), getting_paid_books.short_paid_business("Utrecht Cafe BV")
    for x in (a, b):
        insights.run(x.id, TODAY)
        x.as_ = (lambda tag: lambda role: sign_in(f"{role}@{tag}.test"))(x.tag)
    return SimpleNamespace(a=a, b=b, sent=sent)


def _rec(c, kind):
    return next(r for r in c.get("/api/recommendations").json()["items"] if r["type"] == kind)


def test_numbers_and_reminders_stay_inside_one_business(two):
    a, b = two.a, two.b
    with tenant_session(a.id) as db:  # a second short payment for A only
        story_books.record(db, a.id, "invoice", 380_00, TODAY - timedelta(days=45), counterparty_id=a.ids.cp,
                           due_date=TODAY - timedelta(days=15), reference="INV-9003")
        story_books.record(db, a.id, "bank_txn", 380_00 - 22_40, TODAY - timedelta(days=14), direction="in",
                           description="INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9003")
        getting_paid_books.match(db, a.id)
    insights.run(a.id, TODAY)
    ca, cb = a.as_("books"), b.as_("books")
    assert ca.get("/api/getting-paid").json()["lost_to_short_minor"] == 18_60 + 22_40
    assert cb.get("/api/getting-paid").json()["lost_to_short_minor"] == 18_60
    rec = _rec(ca, "payment_costs")
    assert cb.post(f"/api/recommendations/{rec['id']}/bank-charge").status_code == 404
    chase = _rec(ca, "chase_overdue")
    assert cb.post(f"/api/recommendations/{chase['id']}/next-step").status_code == 404
    a_draft = ca.post(f"/api/recommendations/{chase['id']}/next-step").json()["action"]
    assert ca.post(f"/api/actions/{a_draft['id']}/approve").json()["status"] == "executed"
    with tenant_session(b.id) as db:
        assert db.execute(select(Reminder)).first() is None  # row-level security on reminders
        assert db.get(Record, a.ids.late) is None


def test_who_may_see_and_prepare(two):
    a = two.a
    assert a.as_("staff").get("/api/getting-paid").status_code == 403
    rec = _rec(a.as_("books"), "chase_overdue")
    assert a.as_("staff").post(f"/api/recommendations/{rec['id']}/bank-charge").status_code == 403


def test_only_an_owner_approves_a_final_notice(two):
    a = two.a
    with tenant_session(a.id) as db:
        act = actions.propose(db, a.id, "send_payment_reminder", requested_by="ai:test", summary="Final notice",
                              payload={"counterparty_id": str(a.ids.cp), "subject": "Final notice", "body": "Pay now.",
                                       "stage": 3, "record_ids": [str(a.ids.late)]})
        aid = act.id
    for role in ("books", "finance"):
        r = a.as_(role).post(f"/api/actions/{aid}/approve")
        assert r.status_code == 403 and "business owner" in r.json()["detail"]
    assert two.sent == []
    assert a.as_("owner").post(f"/api/actions/{aid}/approve").json()["status"] == "executed"


def test_a_bank_charge_never_closes_an_invoice_that_did_not_arrive_short(two):
    a = two.a
    with tenant_session(a.id) as db:  # a payload naming a normal unpaid invoice is refused by the handler
        act = actions.propose(db, a.id, "record_bank_charge", requested_by="ai:test", summary="Bank charge",
                              payload={"record_ids": [str(a.ids.late)]}, amount_minor=360_00)
        aid = act.id
    r = a.as_("finance").post(f"/api/actions/{aid}/approve")
    assert r.status_code == 409
    with tenant_session(a.id) as db:
        inv = db.get(Record, a.ids.late)
        assert (inv.status, inv.open_minor) == ("open", 360_00)
        assert db.get(Action, aid).status == "pending"


@pytest.mark.parametrize("key", ["sk_test_fullaccess", "sk_live_realmoney", "rk_live_realmoney", "pk_test_public"])
def test_only_a_sandbox_restricted_key_makes_links(two, monkeypatch, key):
    monkeypatch.setattr(get_settings(), "stripe_links_key", SecretStr(key))
    assert not payment_links.configured() and "rk_test_" in payment_links.problem()

    def refuse(**kw):
        raise AssertionError("no call to Stripe may be made with this key")

    monkeypatch.setattr(outbound, "client", refuse)
    c = two.a.as_("books")
    assert c.get("/api/getting-paid").json()["links_problem"]
    rec = _rec(c, "chase_overdue")
    draft = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert "No card payment link: payment links aren't set up yet" in draft["effects"]
    assert c.post(f"/api/actions/{draft['id']}/approve").json()["result"]["links"] == 0
    assert "stripe.com" not in two.sent[-1]


@pytest.fixture
def stripe_answers(monkeypatch):
    """A fake Stripe; set .link to what it returns for a payment link."""
    state = SimpleNamespace(link={"id": "plink_1", "livemode": False, "url": "https://buy.stripe.com/test_1"},
                            calls=[])

    def answer(request: httpx.Request) -> httpx.Response:
        state.calls.append(request.url.path)
        if request.url.path == "/v1/prices":
            return httpx.Response(200, json={"id": "price_1", "livemode": False})
        return httpx.Response(200, json=state.link)

    real = outbound.client
    monkeypatch.setattr(outbound, "client", lambda **kw: real(transport=httpx.MockTransport(answer), **kw))
    monkeypatch.setattr(get_settings(), "stripe_links_key", SecretStr("rk_test_linksonly"))
    return state


@pytest.mark.parametrize("link", [
    {"id": "plink_1", "livemode": False, "url": "https://evil.example/pay"},  # not Stripe's own page
    {"id": "plink_1", "livemode": True, "url": "https://buy.stripe.com/live_1"},  # live mode
])
def test_an_unexpected_link_is_never_sent(two, stripe_answers, link):
    stripe_answers.link = link
    a = two.a
    c = a.as_("books")
    rec = _rec(c, "chase_overdue")
    draft = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert stripe_answers.calls == []  # nothing is made for a draft
    r = c.post(f"/api/actions/{draft['id']}/approve")
    assert r.status_code == 502 and "Nothing was sent" in r.json()["detail"]
    assert two.sent == []
    with tenant_session(a.id) as db:
        assert db.get(Action, draft["id"]).status == "pending"  # the approval isn't used up
        assert db.execute(select(Reminder)).first() is None


def test_link_amounts_come_from_our_records(two, stripe_answers):
    a = two.a
    c = a.as_("books")
    rec = _rec(c, "chase_overdue")
    draft = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert c.post(f"/api/actions/{draft['id']}/approve").json()["status"] == "executed"
    assert stripe_answers.calls == ["/v1/prices", "/v1/payment_links"]
    assert "https://buy.stripe.com/test_1" in two.sent[-1]
    with tenant_session(a.id) as db:
        assert getting_paid.sent(db, [a.ids.late])[a.ids.late].keys() == {1}
