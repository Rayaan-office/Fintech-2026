"""Getting paid faster and for less, end to end: payments that arrive short, the bank charge that
closes them, reminders in three steps (a business owner approves the final notice), and card
payment links that are made only once a reminder is approved, with a sandbox key only.
Stripe and email are faked; nothing leaves the machine."""

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from tests.backend import getting_paid_books, story_books

from app.analytics import getting_paid, health, ledger, rules
from app.config import get_settings
from app.connectors import email_out, outbound
from app.copilot import insights
from app.db import tenant_session
from app.models import Record, Recommendation, Reminder

TODAY = date.today()
SHORT = getting_paid_books.SHORT


@pytest.fixture(autouse=True)
def _no_links_key(monkeypatch):
    """Never a real payment link from a test, whatever .env holds; tests that need one fake Stripe."""
    monkeypatch.setattr(get_settings(), "stripe_links_key", None)


@pytest.fixture
def shop(businesses, sign_in, monkeypatch):
    """A new business with a customer abroad (tests/backend/getting_paid_books.py). AI is paused, so
    our templates are used."""
    shop = getting_paid_books.short_paid_business()
    assert shop.matched["auto"] == 1  # the reference and the amount, less a usual charge
    sent: list = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append(
        SimpleNamespace(to=to, subject=subject, body=body)) or "<id@x>")
    shop.sent, shop.as_ = sent, lambda role: sign_in(f"{role}@{shop.tag}.test")
    return shop


_match = getting_paid_books.match


def _recs(c, kind: str) -> list[dict]:
    return [r for r in c.get("/api/recommendations").json()["items"] if r["type"] == kind]


def _check(shop):
    return insights.run(shop.id, TODAY)


def _days_ago(shop, days: int):
    """Pretend every reminder so far was sent this many days ago."""
    with tenant_session(shop.id) as db:
        for r in db.execute(select(Reminder)).scalars():
            r.sent_at = datetime.now(UTC) - timedelta(days=days)


# ── Payments that arrive short ─────────────────────────────────────────────


def test_short_payment_is_recorded_and_not_owed(shop):
    with tenant_session(shop.id) as db:
        inv = db.get(Record, shop.ids.paid)
        assert (inv.status, inv.open_minor) == ("open", SHORT)  # still open in the books
        assert ledger.short_paid(db)[inv.id].short_minor == SHORT
        open_ids = {r.id for r in ledger.open_items(db, "invoice")[0]}
        assert open_ids == {shop.ids.late}  # what arrived short is not owed
        owed = health.who_owes_you(db, TODAY)
        assert (owed["total_minor"], owed["overdue_minor"]) == (360_00, 360_00)
        assert (owed["short_paid_minor"], owed["short_paid_count"]) == (SHORT, 1)
        n = getting_paid.numbers(db, TODAY)
    assert (n["lost_to_short_minor"], n["short_payments"]) == (SHORT, 1)
    assert (n["left_to_record_minor"], n["left_to_record_count"]) == (SHORT, 1)
    intl = next(m for m in n["methods"] if m["method"] == "international_transfer")
    assert (intl["payments"], intl["short_minor"], intl["days_to_pay"]) == (1, SHORT, 32)
    # A typical card rate for a card from abroad, as this business has no card payments of its own
    assert intl["card_fee_minor"] == round(400_00 * 0.0325) + 20 and intl["card_fee_is_estimate"]
    assert n["could_save_minor"] == SHORT - intl["card_fee_minor"] == 5_40  # £18.60 lost against £13.20 by card


def test_payment_costs_recommendation_offers_the_bank_charge(shop):
    _check(shop)
    c = shop.as_("books")
    assert _recs(c, "payment_costs") == []  # one short payment is not a pattern yet

    # A second payment arrives short: now it is
    with tenant_session(shop.id) as db:
        inv = story_books.record(db, shop.id, "invoice", 380_00, TODAY - timedelta(days=45),
                                 counterparty_id=shop.ids.cp, due_date=TODAY - timedelta(days=15), reference="INV-9003")
        story_books.record(db, shop.id, "bank_txn", 380_00 - 22_40, TODAY - timedelta(days=14), direction="in",
                           description="INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9003")
        assert _match(db, shop.id)["auto"] == 1
        third = inv.id
    _check(shop)
    rec = _recs(c, "payment_costs")[0]
    assert rec["title"] == "Rotterdam Bakery BV's payments arrived £41.00 short"
    gp = rec["getting_paid"]
    assert (gp["short_minor"], gp["short_payments"], gp["leftover_minor"]) == (41_00, 2, 41_00)
    assert gp["card_rate"]["source"] == "typical" and "3.25% + 20p" in gp["card_rate"]["label"]
    assert gp["card_fee_minor"] == (round(400_00 * 0.0325) + 20) + (round(380_00 * 0.0325) + 20)
    assert gp["saving_minor"] == 41_00 - gp["card_fee_minor"]
    assert gp["tip"] == "Send a card payment link with the next reminder"
    step = rec["next_step"]
    assert (step["kind"], step["label"]) == ("record_bank_charge", "Record £41.00 as bank charges")
    assert {x["record_id"] for x in gp["leftovers"]} == {str(shop.ids.paid), str(third)}
    assert "3.25% + 20p" in rec["why"]


def test_recording_the_bank_charge_closes_the_invoice(shop):
    with tenant_session(shop.id) as db:
        story_books.record(db, shop.id, "invoice", 380_00, TODAY - timedelta(days=45), counterparty_id=shop.ids.cp,
                           due_date=TODAY - timedelta(days=15), reference="INV-9003")
        story_books.record(db, shop.id, "bank_txn", 380_00 - 22_40, TODAY - timedelta(days=14), direction="in",
                           description="INTL PAYMENT ROTTERDAM BAKERY BV SWIFT REF INV-9003")
        assert _match(db, shop.id)["auto"] == 1
    _check(shop)
    books, finance = shop.as_("books"), shop.as_("finance")
    rec = _recs(books, "payment_costs")[0]

    a = books.post(f"/api/recommendations/{rec['id']}/bank-charge").json()["action"]
    assert (a["type"], a["status"], a["level"], a["amount_minor"]) == ("record_bank_charge", "pending", 2, 41_00)
    assert a["can_approve"] is False and "Mark those invoices as paid on the day their payment arrived" in a["effects"]
    assert books.post(f"/api/recommendations/{rec['id']}/bank-charge").json()["action"]["id"] == a["id"]  # no repeat
    with tenant_session(shop.id) as db:
        assert db.get(Record, shop.ids.paid).status == "open"  # nothing changes before approval
    assert books.post(f"/api/actions/{a['id']}/approve").status_code == 403  # bookkeepers can't

    done = finance.post(f"/api/actions/{a['id']}/approve").json()
    assert done["status"] == "executed" and done["result"]["amount_minor"] == 41_00
    with tenant_session(shop.id) as db:
        inv = db.get(Record, shop.ids.paid)
        assert (inv.status, inv.open_minor, inv.paid_date) == ("paid", 0, TODAY - timedelta(days=28))
        fees = db.execute(select(Record).where(Record.category == "bank_charges")).scalars().all()
        assert sorted(f.amount_minor for f in fees) == [SHORT, 22_40] and all(f.kind == "fee" for f in fees)
        assert {f.date for f in fees} == {TODAY - timedelta(days=28), TODAY - timedelta(days=14)}
        assert db.get(Recommendation, rec["id"]).status == "done"
        n = getting_paid.numbers(db, TODAY)
        assert (n["left_to_record_minor"], n["lost_to_short_minor"]) == (0, 41_00)  # still lost, now recorded
        assert health.who_owes_you(db, TODAY)["short_paid_minor"] == 0

    # Small changes can be undone: the leftovers come back
    assert finance.post(f"/api/actions/{a['id']}/undo").json()["status"] == "undone"
    with tenant_session(shop.id) as db:
        inv = db.get(Record, shop.ids.paid)
        assert (inv.status, inv.open_minor, inv.paid_date) == ("open", SHORT, None)
        assert {f.status for f in db.execute(select(Record).where(Record.category == "bank_charges")).scalars()} == {
            "void"}


# ── Reminders in three steps ───────────────────────────────────────────────


def _draft_and_approve(shop, approver: str = "books") -> dict:
    c = shop.as_("books")
    rec = _recs(c, "chase_overdue")[0]
    a = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    out = shop.as_(approver).post(f"/api/actions/{a['id']}/approve")
    return {"rec": rec, "action": a, "response": out}


def test_reminders_escalate_on_time_and_the_final_notice_needs_the_owner(shop):
    _check(shop)
    rec = _recs(shop.as_("books"), "chase_overdue")[0]
    gp = rec["getting_paid"]["reminder"]
    assert (gp["stage"], gp["of"], gp["tone"], gp["owner_only"]) == (1, 3, "friendly", False)
    assert [i["reference"] for i in gp["invoices"]] == ["INV-9002"]  # never the £18.60 left after INV-9001
    assert rec["next_step"]["label"] == "Draft reminder 1 of 3 to Rotterdam Bakery BV"

    first = _draft_and_approve(shop)
    assert first["response"].json()["status"] == "executed" and first["response"].json()["result"]["stage"] == 1
    assert shop.sent[-1].subject.startswith("Payment reminder from") and "INV-9002" in shop.sent[-1].body
    assert "INV-9001" not in shop.sent[-1].body

    _check(shop)
    assert _recs(shop.as_("books"), "chase_overdue") == []  # the next one waits 7 days
    _days_ago(shop, 6)
    _check(shop)
    assert _recs(shop.as_("books"), "chase_overdue") == []
    _days_ago(shop, 7)
    _check(shop)
    second = _draft_and_approve(shop)
    assert second["rec"]["getting_paid"]["reminder"]["stage"] == 2
    assert second["response"].json()["status"] == "executed"
    assert shop.sent[-1].subject.startswith("Second reminder") and "still unpaid" in shop.sent[-1].body

    _days_ago(shop, 13)
    _check(shop)
    assert _recs(shop.as_("books"), "chase_overdue") == []  # the final notice waits 14 days
    _days_ago(shop, 14)
    _check(shop)
    c = shop.as_("books")
    rec = _recs(c, "chase_overdue")[0]
    assert rec["getting_paid"]["reminder"]["owner_only"] and rec["next_step"]["label"].startswith("Draft the final")
    a = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert a["approvers"] == "A business owner" and "a business owner must approve it" in " ".join(a["reasons"])
    for role in ("books", "finance"):
        r = shop.as_(role).post(f"/api/actions/{a['id']}/approve")
        assert r.status_code == 403 and r.json()["detail"] == "Only a business owner can approve a final notice."
    assert len(shop.sent) == 2
    assert shop.as_("owner").post(f"/api/actions/{a['id']}/approve").json()["status"] == "executed"
    assert shop.sent[-1].subject.startswith("Final notice")

    with tenant_session(shop.id) as db:
        assert sorted(r.stage for r in db.execute(select(Reminder)).scalars()) == [1, 2, 3]
    _days_ago(shop, 30)
    _check(shop)
    assert _recs(shop.as_("books"), "chase_overdue") == []  # nothing after the final notice


def test_numbers_show_the_stage_each_invoice_was_paid_at(shop):
    _check(shop)
    _draft_and_approve(shop)
    with tenant_session(shop.id) as db:  # INV-9002 is paid in full the day after the reminder
        story_books.record(db, shop.id, "bank_txn", 360_00, TODAY, direction="in",
                           description="ROTTERDAM BAKERY BV REF INV-9002")
        assert _match(db, shop.id)["auto"] == 1
    with tenant_session(shop.id) as db:
        n = getting_paid.numbers(db, TODAY)
    # INV-9001 was paid before any reminder, INV-9002 after the first
    assert {(s["stage"], s["invoices"]) for s in n["paid_after_reminder"]} == {(0, 1), (1, 1)}


# ── Card payment links ─────────────────────────────────────────────────────


@pytest.fixture
def stripe_links(monkeypatch):
    """A fake Stripe that makes prices and payment links, and the sandbox key that allows it."""
    calls: list = []

    def answer(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/prices":
            return httpx.Response(200, json={"id": "price_test_1", "object": "price", "livemode": False})
        if request.url.path == "/v1/payment_links":
            return httpx.Response(200, json={"id": "plink_test_1", "object": "payment_link", "livemode": False,
                                             "url": "https://buy.stripe.com/test_00g5kE"})
        return httpx.Response(404, json={"error": {"message": "unknown"}})

    real = outbound.client
    monkeypatch.setattr(outbound, "client", lambda **kw: real(transport=httpx.MockTransport(answer), **kw))
    monkeypatch.setattr(get_settings(), "stripe_links_key", SecretStr("rk_test_linksonly"))
    return calls


def test_payment_link_is_made_only_after_approval_and_reused(shop, stripe_links):
    _check(shop)
    c = shop.as_("books")
    rec = _recs(c, "chase_overdue")[0]
    assert rec["getting_paid"]["reminder"]["link"] == "all"
    a = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert "Once approved, add a link to pay each invoice online by card (made only then)" in a["effects"]
    assert stripe_links == []  # nothing is made for a draft
    assert c.post(f"/api/actions/{a['id']}/approve").json()["result"]["links"] == 1

    assert [r.url.path for r in stripe_links] == ["/v1/prices", "/v1/payment_links"]
    price = dict(httpx.QueryParams(stripe_links[0].content.decode()))
    assert (price["unit_amount"], price["currency"]) == ("36000", "gbp")
    assert price["product_data[name]"] == "Invoice INV-9002"
    keys = {r.headers["Idempotency-Key"] for r in stripe_links}
    assert len(keys) == 2 and all(str(shop.ids.late) in k for k in keys)  # one per invoice, retried safely
    assert all(r.headers["Authorization"].startswith("Basic ") for r in stripe_links)
    assert "You can pay online by card:\n- INV-9002 (£360.00): https://buy.stripe.com/test_00g5kE" in shop.sent[-1].body
    with tenant_session(shop.id) as db:
        r = db.execute(select(Reminder)).scalar_one()
        assert (r.link_url, r.link_minor) == ("https://buy.stripe.com/test_00g5kE", 360_00)

    # The firmer reminder a week later carries the same link; nothing new is made
    _days_ago(shop, 7)
    _check(shop)
    _draft_and_approve(shop)
    assert len(stripe_links) == 2 and "https://buy.stripe.com/test_00g5kE" in shop.sent[-1].body


def test_without_a_links_key_the_reminder_goes_without_a_link_and_says_so(shop, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_links_key", None)
    _check(shop)
    c = shop.as_("books")
    rec = _recs(c, "chase_overdue")[0]
    assert rec["getting_paid"]["reminder"]["link"] == "none" and "payment link key" in rec["summary"]["text"]
    a = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert "No card payment link: payment links aren't set up yet" in a["effects"]
    assert c.post(f"/api/actions/{a['id']}/approve").json()["result"]["links"] == 0
    assert "stripe.com" not in shop.sent[-1].body
    with tenant_session(shop.id) as db:
        assert getting_paid.numbers(db, TODAY)["links_configured"] is False


def test_a_stripe_invoice_uses_its_own_payment_page(shop, monkeypatch):
    monkeypatch.setattr(get_settings(), "stripe_links_key", None)
    page = "https://invoice.stripe.com/i/acct_test/test_YWNjdF8x"
    with tenant_session(shop.id) as db:
        inv = db.get(Record, shop.ids.late)
        inv.source, inv.external = "stripe", {"stripe_invoice": "in_test_1", "hosted_invoice_url": page}
    _check(shop)
    rec = _recs(shop.as_("books"), "chase_overdue")[0]
    assert rec["getting_paid"]["reminder"]["invoices"][0]["link"] == "invoice_page"
    _draft_and_approve(shop)
    assert page in shop.sent[-1].body


def test_own_card_fees_and_days_sooner_by_card(shop):
    """With 3 card payments of its own, the business's own card fees are used, and we can say how
    much sooner card payments arrive."""
    with tenant_session(shop.id) as db:
        for n, days in enumerate((5, 7, 9)):
            issued = TODAY - timedelta(days=40 + n)
            story_books.record(db, shop.id, "invoice", 200_00, issued, source="stripe", status="paid", open_minor=0,
                               paid_date=issued + timedelta(days=days), source_ref=f"in_{n}",
                               external={"stripe_invoice": f"in_{n}"}, counterparty_id=shop.ids.cp)
            story_books.record(db, shop.id, "payment_in", 200_00, issued + timedelta(days=days), source="stripe",
                               source_ref=f"ch_{n}", external={"invoice": f"in_{n}"}, method="card")
            story_books.record(db, shop.id, "fee", 3_20, issued + timedelta(days=days), source="stripe",
                               source_ref=f"ch_{n}:fee", category="card_fees", external={"charge": f"ch_{n}"})
        n = getting_paid.numbers(db, TODAY)
        found = {f.kind: f for f in getting_paid.payment_costs(db, TODAY)}
    assert n["card_rate"]["source"] == "yours" and n["card_rate"]["rate"] == 0.016  # £9.60 of £600.00
    assert n["days_to_pay_by_card"] == 7.0
    card = next(m for m in n["methods"] if m["method"] == "card")
    assert (card["payments"], card["card_fee_minor"], card["card_fee_is_estimate"]) == (3, 3 * 3_20, False)
    # INV-9001 took 32 days by international transfer, 25 days longer than this customer's card payments
    f = found["payment_costs"]
    assert f.title == "Rotterdam Bakery BV takes 25 days longer to pay by international transfer"
    assert f.facts["days sooner by card"] == "25" and f.next_step["action"] == "record_bank_charge"
    assert "Card fees are your own." in f.why


def test_story_international_customer(businesses):
    """The demo story's customer abroad: every payment arrived short and is waiting to be recorded."""
    bid, _, s, _ = story_books.story_business()
    short = [i for i in s.invoices if i.short]
    assert short and all(12_00 <= i.short <= 25_00 for i in short)
    with tenant_session(bid) as db:
        n = getting_paid.numbers(db, TODAY)
        found = {f.kind: f for f in rules.find_all(db, TODAY) if f.counterparty_id
                 and ledger.names(db)[f.counterparty_id] == "Amsterdam Bakehouse BV"}
    recent = [i for i in short if i.paid_on >= TODAY - timedelta(days=180)]
    assert n["lost_to_short_minor"] == sum(i.short for i in recent)
    assert n["left_to_record_minor"] == sum(i.short for i in short)
    f = found["payment_costs"]
    assert f.facts["arrived short in all"] == f"£{sum(i.short for i in recent) / 100:,.2f}"
    assert f.next_step["action"] == "record_bank_charge"
    overdue = [i for i in s.invoices if i.customer == "Amsterdam Bakehouse BV" and not i.paid_on and i.due < TODAY]
    assert overdue and found["chase_overdue"].money_at_stake_minor == sum(i.total for i in overdue)
