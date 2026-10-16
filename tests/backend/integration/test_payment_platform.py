"""The payment platform (Stripe) connector, against a fake Stripe that answers in the shapes of
the API version we pin. The live contract test (tests/backend/contract) checks those shapes."""

import copy
import json
import time
from types import SimpleNamespace

import pytest
import stripe
from pydantic import SecretStr
from sqlalchemy import func, select

from app.connectors import stripe_conn
from app.db import tenant_session
from app.models import Account, AuditEntry, Connection, Counterparty, CounterpartyVersion, Record
from app.pipeline import counterparties
from app.privacy.redact import vault_values
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people

NOW = int(time.time())
DAY = 86_400
SECRET = "whsec_testsecretfortheseteststhatisnotreal"


def _list(*items) -> dict:
    return {"object": "list", "data": list(items), "has_more": False}


def sandbox() -> dict:
    """What our fake Stripe sandbox holds: two customers, a paid and an open invoice, card payments
    with fees, a refund, a dispute, a payout and the balance."""
    return {
        "customers": _list(
            {"id": "cus_station", "object": "customer", "livemode": False, "name": "Station Coffee Company Ltd",
             "email": "accounts@stationcoffee.example"},
            {"id": "cus_hotel", "object": "customer", "livemode": False, "name": "Harrogate Grand Hotel",
             "email": "ap@harrogategrand.example"},
        ),
        "invoice_payments": _list(
            {"id": "inpay_1", "object": "invoice_payment", "livemode": False, "invoice": "in_paid", "status": "paid",
             "payment": {"type": "payment_intent", "payment_intent": "pi_invoice"}},
        ),
        "invoices": _list(
            {"id": "in_paid", "object": "invoice", "livemode": False, "status": "paid", "currency": "gbp",
             "customer": "cus_station", "number": "CAKE-0001", "description": "Special order: celebration cake",
             "total": 10200, "amount_remaining": 0, "created": NOW - 3 * DAY, "due_date": NOW + 11 * DAY,
             "status_transitions": {"paid_at": NOW - 2 * DAY}, "total_taxes": [{"amount": 1700}],
             "lines": {"data": [{"description": "Celebration cake", "quantity": 1, "amount": 8500}]}},
            {"id": "in_open", "object": "invoice", "livemode": False, "status": "open", "currency": "gbp",
             "customer": "cus_hotel", "number": "CAKE-0002", "description": "Deposit: afternoon tea pastries",
             "total": 54000, "amount_remaining": 54000, "created": NOW - DAY, "due_date": NOW + 13 * DAY,
             "status_transitions": {}, "total_taxes": [{"amount": 9000}], "lines": {"data": []}},
            {"id": "in_draft", "object": "invoice", "livemode": False, "status": "draft", "currency": "gbp",
             "total": 100, "amount_remaining": 100, "created": NOW},
        ),
        "charges": _list(
            {"id": "ch_invoice", "object": "charge", "livemode": False, "status": "succeeded", "amount": 10200,
             "amount_refunded": 0, "currency": "gbp", "created": NOW - 2 * DAY, "customer": "cus_station",
             "description": "Payment for Invoice", "metadata": {}, "payment_intent": "pi_invoice", "disputed": False,
             "balance_transaction": {"id": "txn_1", "fee": 173, "net": 10027, "currency": "gbp"}},
            {"id": "ch_counter", "object": "charge", "livemode": False, "status": "succeeded", "amount": 1260,
             "amount_refunded": 1260, "currency": "gbp", "created": NOW - DAY, "customer": None,
             "description": "Counter sale: croissants", "metadata": {}, "payment_intent": "pi_counter",
             "balance_transaction": {"id": "txn_2", "fee": 39, "net": 1221, "currency": "gbp"}},
            {"id": "ch_disputed", "object": "charge", "livemode": False, "status": "succeeded", "amount": 4600,
             "amount_refunded": 0, "currency": "gbp", "created": NOW - DAY, "customer": "cus_hotel",
             "description": "Online order", "metadata": {}, "payment_intent": "pi_disputed", "disputed": True,
             "balance_transaction": {"id": "txn_3", "fee": 89, "net": 4511, "currency": "gbp"}},
            {"id": "ch_declined", "object": "charge", "livemode": False, "status": "failed", "amount": 1150,
             "amount_refunded": 0, "currency": "gbp", "created": NOW, "metadata": {}, "balance_transaction": None},
        ),
        "refunds": _list(
            {"id": "re_1", "object": "refund", "livemode": False, "status": "succeeded", "amount": 1260,
             "currency": "gbp", "created": NOW, "charge": "ch_counter", "reason": "requested_by_customer"},
        ),
        "disputes": _list(
            {"id": "dp_1", "object": "dispute", "livemode": False, "status": "needs_response", "amount": 4600,
             "currency": "gbp", "created": NOW, "charge": "ch_disputed", "reason": "fraudulent",
             "balance_transactions": [{"id": "txn_4", "amount": -6600, "fee": 2000, "currency": "gbp"}]},
        ),
        "payouts": _list(
            {"id": "po_1", "object": "payout", "livemode": False, "status": "in_transit", "amount": 95000,
             "currency": "gbp", "created": NOW - DAY, "arrival_date": NOW + DAY,
             "statement_descriptor": "STRIPE PAYMENTS UK", "automatic": True},
        ),
        "balance": {"object": "balance", "livemode": False, "available": [{"currency": "gbp", "amount": 12000}],
                    "pending": [{"currency": "gbp", "amount": 3400}]},
    }


@pytest.fixture
def fake_stripe(monkeypatch):
    state = SimpleNamespace(data=sandbox(), calls=[])

    def _get(path, params=None):
        state.calls.append(path)
        if path not in state.data:
            raise stripe_conn.StripeError(404, f"Stripe answered 404: {path}")
        answer = state.data[path]
        if isinstance(answer, Exception):
            raise answer
        return copy.deepcopy(answer)

    monkeypatch.setattr(stripe_conn, "_get", _get)
    return state


@pytest.fixture(scope="module")
def biz(businesses):
    d = create_business("Business D", people("d"), {e: PASSWORD for e, *_ in people("d")}, inbox="bills@d.test")
    with tenant_session(d.id) as db:  # a customer already known from a document
        counterparties.find_or_create(db, d.id, "customer", "Station Coffee Co")
    return SimpleNamespace(id=d.id)


@pytest.fixture
def finance(sign_in, biz):
    return sign_in("finance@d.test")


def _records(bid) -> dict[str, Record]:
    with tenant_session(bid) as db:
        rows = db.execute(select(Record).where(Record.source == "stripe")).scalars().all()
        db.expunge_all()
    return {r.source_ref: r for r in rows}


def _connect(client) -> dict:
    r = client.post("/api/connections/stripe/connect")
    assert r.status_code == 200, r.text
    return r.json()


# ── Sync ───────────────────────────────────────────────────────────────────


def test_connect_reads_everything(finance, biz, fake_stripe):
    counts = _connect(finance)["counts"]
    assert counts == {"customers": 2, "invoices": 2, "payments": 3, "fees": 3, "refunds": 1, "disputes": 1,
                      "payouts": 1, "balances": 1}
    recs = _records(biz.id)

    paid, open_ = recs["in_paid"], recs["in_open"]
    assert (paid.kind, paid.status, paid.open_minor, paid.tax_minor) == ("invoice", "paid", 0, 1700)
    assert paid.paid_date is not None and paid.lines[0]["description"] == "Celebration cake"
    assert (open_.status, open_.open_minor, open_.currency) == ("open", 54000, "GBP")
    assert "in_draft" not in recs

    # The card payment knows which invoice it paid, through Stripe's invoice payments
    pay = recs["ch_invoice"]
    assert pay.kind == "payment_in" and pay.external["invoice"] == "in_paid" and pay.reference == "CAKE-0001"
    assert pay.counterparty_id == paid.counterparty_id
    assert recs["ch_invoice:fee"].amount_minor == 173 and recs["ch_invoice:fee"].kind == "fee"
    assert "ch_declined" not in recs

    assert (recs["re_1"].kind, recs["re_1"].direction, recs["re_1"].amount_minor) == ("refund", "out", 1260)
    assert recs["dp_1"].category == "disputes" and recs["dp_1:fee"].amount_minor == 2000
    assert recs["dp_1"].counterparty_id == open_.counterparty_id

    po = recs["po_1"]
    assert (po.kind, po.status, po.amount_minor) == ("payout", "pending", 95000)

    with tenant_session(biz.id) as db:
        acct = db.execute(select(Account).where(Account.source == "stripe")).scalar_one()
        assert (acct.currency, acct.balance_minor, acct.available_minor) == ("GBP", 15400, 12000)


def test_stripe_customer_joins_the_customer_we_already_know(finance, biz, fake_stripe):
    _connect(finance)
    with tenant_session(biz.id) as db:
        rows = db.execute(select(Counterparty).where(Counterparty.kind == "customer")).scalars().all()
        station = [c for c in rows if "station" in c.normalized_name]
        assert len(station) == 1 and station[0].external_ids["stripe"] == "cus_station"
        assert station[0].email_domain == "stationcoffee.example"


def test_customer_email_goes_into_the_vault_only(finance, biz, fake_stripe):
    _connect(finance)
    with tenant_session(biz.id) as db:
        cp = db.execute(select(Counterparty).where(Counterparty.external_ids["stripe"].astext == "cus_hotel")).scalar_one()
        email = counterparties.latest_details(db, cp.id)["email"]
    assert email["display"] == "a•••@harrogategrand.example"
    assert vault_values(biz.id, [email["vault"]]) == {email["vault"]: "ap@harrogategrand.example"}


def test_syncing_again_changes_nothing(finance, biz, fake_stripe):
    _connect(finance)
    before = len(_records(biz.id))
    with tenant_session(biz.id) as db:
        versions = db.scalar(select(func.count()).select_from(CounterpartyVersion))
    r = finance.post("/api/connections/stripe/sync")
    assert r.status_code == 200
    assert len(_records(biz.id)) == before
    with tenant_session(biz.id) as db:
        assert db.scalar(select(func.count()).select_from(CounterpartyVersion)) == versions


def test_renamed_customer_stays_linked(finance, biz, fake_stripe):
    _connect(finance)
    fake_stripe.data["customers"]["data"][1]["name"] = "The Harrogate Grand"
    finance.post("/api/connections/stripe/sync")
    with tenant_session(biz.id) as db:
        rows = db.execute(select(Counterparty).where(Counterparty.external_ids["stripe"].astext == "cus_hotel")).all()
    assert len(rows) == 1


def test_invoice_changes_follow_stripe(finance, biz, fake_stripe):
    _connect(finance)
    inv = fake_stripe.data["invoices"]["data"][1]
    inv["status"] = "uncollectible"
    finance.post("/api/connections/stripe/sync")
    rec = _records(biz.id)["in_open"]
    assert (rec.status, rec.open_minor, rec.external["written_off"]) == ("void", 0, True)


def test_won_dispute_is_no_longer_money_out(finance, biz, fake_stripe):
    _connect(finance)
    fake_stripe.data["disputes"]["data"][0]["status"] = "won"
    finance.post("/api/connections/stripe/sync")
    assert _records(biz.id)["dp_1"].status == "void"


def test_malformed_objects_are_skipped_and_counted(finance, biz, fake_stripe):
    charges = fake_stripe.data["charges"]["data"]
    charges.append({"id": "ch_bad", "object": "charge", "status": "succeeded", "amount": -500, "currency": "gbp",
                    "created": NOW})
    charges.append({"object": "charge", "status": "succeeded", "amount": 500, "currency": "gbp", "created": NOW})
    counts = _connect(finance)["counts"]
    assert counts["skipped"] == 2 and counts["payments"] == 3
    assert "ch_bad" not in _records(biz.id)


def test_live_mode_data_is_refused_and_the_card_shows_why(finance, biz, fake_stripe):
    fake_stripe.data["payouts"]["data"][0]["livemode"] = True
    r = finance.post("/api/connections/stripe/sync")
    assert r.status_code == 409 and "sandbox" in r.json()["detail"]
    card = next(c for c in finance.get("/api/connections").json()["items"] if c["provider"] == "stripe")
    assert card["status"] == "error" and "sandbox" in card["error"]


def test_rejected_key_marks_the_connection_expired(finance, biz, fake_stripe):
    fake_stripe.data["balance"] = stripe_conn.StripeError(401, "Stripe answered 401: Invalid API Key")
    r = finance.post("/api/connections/stripe/sync")
    assert r.status_code == 502 and "rejected our key" in r.json()["detail"]
    with tenant_session(biz.id) as db:
        assert db.execute(select(Connection).where(Connection.kind == "payments")).scalar_one().status == "expired"


def test_bookkeeper_cannot_connect(sign_in, biz, fake_stripe):
    r = sign_in("books@d.test").post("/api/connections/stripe/connect")
    assert r.status_code == 403


def test_a_second_business_cannot_take_over_the_stripe_account(sign_in, biz, fake_stripe, finance):
    _connect(finance)
    e = create_business("Business E", people("e"), {x: PASSWORD for x, *_ in people("e")}, inbox="bills@e.test")
    r = sign_in("finance@e.test").post("/api/connections/stripe/connect")
    assert r.status_code == 409 and "another business" in r.json()["detail"]
    with tenant_session(e.id) as db:
        assert db.scalar(select(func.count()).select_from(Record)) == 0


@pytest.mark.parametrize("key", ["sk_test_full_access", "rk_live_real_money", ""])
def test_only_a_read_only_sandbox_key_is_used(monkeypatch, key):
    monkeypatch.setattr(stripe_conn._s, "stripe_api_key", SecretStr(key))
    with pytest.raises(stripe_conn.StripeError):
        stripe_conn._key()


# ── Notifications ──────────────────────────────────────────────────────────


def signed(event: dict, secret: str = SECRET, at: int | None = None) -> tuple[bytes, str]:
    body = json.dumps(event).encode()
    ts = at or int(time.time())
    sig = stripe.WebhookSignature._compute_signature(f"{ts}.{body.decode()}", secret)
    return body, f"t={ts},v1={sig}"


def event(id_: str, type_: str = "charge.succeeded", livemode: bool = False) -> dict:
    return {"id": id_, "object": "event", "type": type_, "livemode": livemode, "api_version": stripe_conn.API_VERSION,
            "created": int(time.time()), "data": {"object": {"id": "ch_x", "object": "charge", "amount": 99999999}}}


@pytest.fixture
def notifications(monkeypatch, finance, biz, fake_stripe, client):
    monkeypatch.setattr(stripe_conn._s, "stripe_webhook_secret", SecretStr(SECRET))
    _connect(finance)
    syncs = []
    real = stripe_conn.sync
    monkeypatch.setattr(stripe_conn, "sync", lambda db, bid: syncs.append(bid) or real(db, bid))

    def post(evt: dict, **kw):
        body, sig = signed(evt, **kw)
        return client.post("/webhooks/stripe", content=body,
                           headers={"stripe-signature": sig, "content-type": "application/json"})

    return SimpleNamespace(post=post, syncs=syncs, client=client)


def _audits(bid, action):
    with tenant_session(bid) as db:
        return db.scalar(select(func.count()).select_from(AuditEntry).where(AuditEntry.event == action))


def test_signed_notification_rereads_from_stripe(notifications, biz):
    before = _audits(biz.id, "notification_received")
    r = notifications.post(event("evt_ok_1"))
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert notifications.syncs == [biz.id]
    assert _audits(biz.id, "notification_received") == before + 1
    # The notification's own contents (an amount of £999,999.99) were never used
    assert "ch_x" not in _records(biz.id)


def test_replayed_notification_is_ignored(notifications, biz):
    notifications.post(event("evt_replay_1"))
    r = notifications.post(event("evt_replay_1"))
    assert r.json() == {"duplicate": True} and len(notifications.syncs) == 1


def test_wrong_or_missing_signature_is_refused(notifications):
    body, _ = signed(event("evt_bad_1"))
    for headers in ({}, {"stripe-signature": "t=1,v1=deadbeef"}):
        r = notifications.client.post("/webhooks/stripe", content=body, headers=headers)
        assert r.status_code == 400
    assert notifications.post(event("evt_bad_2"), secret="whsec_someoneelse").status_code == 400
    assert notifications.syncs == []


def test_old_signed_notification_is_refused(notifications):
    r = notifications.post(event("evt_old_1"), at=int(time.time()) - 600)
    assert r.status_code == 400 and notifications.syncs == []


def test_live_mode_notification_is_refused(notifications):
    assert notifications.post(event("evt_live_1", livemode=True)).status_code == 400


def test_unrelated_notification_is_acknowledged_without_a_read(notifications):
    r = notifications.post(event("evt_other_1", type_="product.created"))
    assert r.json() == {"ignored": True} and notifications.syncs == []


def test_notification_for_a_disconnected_account_is_ignored(notifications, finance):
    finance.post("/api/connections/stripe/disconnect")
    r = notifications.post(event("evt_disc_1"))
    assert r.json() == {"ignored": True} and notifications.syncs == []
