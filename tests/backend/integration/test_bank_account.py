"""The bank connector (Plaid), against a fake Plaid sandbox that answers in the shapes the real
one uses. The live contract test (tests/backend/contract) checks those shapes."""

import copy
import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app import scheduler
from app.connectors import plaid_conn
from app.db import tenant_session
from app.models import Account, AuditEntry, Connection, Record
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people

TODAY = date.today()
# Plaid: positive amount = money out
TXNS = {
    "k1": (TODAY - timedelta(days=90), -1450.80, "STATION COFFEE CO REF INV-2001"),
    "k2": (TODAY - timedelta(days=60), 2200.00, "MILL PROPERTIES RENT"),
    "k3": (TODAY - timedelta(days=10), 47.99, "SHELL FUEL"),
    "k4": (TODAY - timedelta(days=3), -1088.10, "STRIPE PAYMENTS UK PAYOUT 0025"),
}


class FakePlaid:
    """Items, each with a list of updates Plaid has ready. A cursor "cN" means N updates read.
    Like the real sandbox, the last 30 days come first and the history a moment later."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.by_token: dict[str, str] = {}
        self.removed: list[str] = []
        self.fail_once: dict[str, str] = {}  # cursor -> error code, raised once
        self.calls: list[str] = []
        self.reads: list[str | None] = []  # which item each call was about

    def txn(self, item, key, **over) -> dict:
        day, amount, name = TXNS[key] if key in TXNS else (TODAY - timedelta(days=1), 12.5, key.upper())
        t = {"transaction_id": f"{item}-{key}", "account_id": f"{item}-acc", "amount": amount,
             "iso_currency_code": "GBP", "date": day.isoformat(), "name": name, "merchant_name": None,
             "pending": False, "pending_transaction_id": None,
             "personal_finance_category": {"primary": "OTHER", "confidence_level": "LOW"}}
        return {**t, **over}

    def new_item(self) -> str:
        n = uuid.uuid4().hex[:10]  # unique across tests, like Plaid's ids
        item = f"item{n}"
        self.items[item] = {
            "token": f"access-sandbox-{n}", "login_required": False, "released": 1, "balance": 20247.79,
            "updates": [
                {"status": "INITIAL_UPDATE_COMPLETE", "added": [self.txn(item, "k3"), self.txn(item, "k4")]},
                {"status": "HISTORICAL_UPDATE_COMPLETE", "added": [self.txn(item, "k1"), self.txn(item, "k2")],
                 "modified": [self.txn(item, "k3"), self.txn(item, "k4")]},
            ],
        }
        self.by_token[self.items[item]["token"]] = item
        return item

    @property
    def item(self) -> dict:
        return self.items[list(self.items)[-1]]

    def push(self, **update) -> None:
        """Plaid has a new update ready for the newest item."""
        it = self.item
        it["updates"].append({"status": "HISTORICAL_UPDATE_COMPLETE", **update})
        it["released"] = len(it["updates"])

    def __call__(self, path: str, body: dict) -> dict:
        self.calls.append(path)
        if path == "/sandbox/public_token/create":
            return {"public_token": f"public-{self.new_item()}"}
        if path == "/item/public_token/exchange":
            item = body["public_token"].removeprefix("public-")
            return {"access_token": self.items[item]["token"], "item_id": item}
        item = self.by_token.get(body.get("access_token"))
        self.reads.append(item)
        if not item or item in self.removed:
            raise plaid_conn.PlaidError("ITEM_NOT_FOUND", "unknown item")
        it = self.items[item]
        if path == "/item/remove":
            self.removed.append(item)
            return {}
        if it["login_required"]:
            raise plaid_conn.PlaidError("ITEM_LOGIN_REQUIRED", "the login details of this item have changed")
        if path == "/accounts/get":
            return {"accounts": [
                {"account_id": f"{item}-acc", "name": "Business Current Account", "mask": "4417", "type": "depository",
                 "subtype": "checking", "balances": {"current": it["balance"], "available": it["balance"],
                                                     "iso_currency_code": "GBP"}},
                {"account_id": f"{item}-card", "name": "Business Card", "mask": "9001", "type": "credit",
                 "subtype": "credit card", "balances": {"current": 310.0, "iso_currency_code": "GBP"}},
            ]}
        if path == "/transactions/sync":
            cursor = body.get("cursor", "")
            if cursor in self.fail_once:
                raise plaid_conn.PlaidError(self.fail_once.pop(cursor), "changed during paging")
            n = int(cursor[1:]) if cursor else 0
            if n >= it["released"]:
                status = it["updates"][it["released"] - 1]["status"]
                return {"added": [], "modified": [], "removed": [], "next_cursor": cursor, "has_more": False,
                        "transactions_update_status": status, "accounts": []}
            up = copy.deepcopy(it["updates"][n])
            return {"added": up.get("added", []), "modified": up.get("modified", []), "removed": up.get("removed", []),
                    "next_cursor": f"c{n + 1}", "has_more": n + 1 < it["released"],
                    "transactions_update_status": up["status"], "accounts": []}
        raise AssertionError(f"unexpected Plaid call {path}")


@pytest.fixture
def fake_plaid(monkeypatch):
    fake = FakePlaid()
    monkeypatch.setattr(plaid_conn, "_post", fake)
    return fake


@pytest.fixture
def biz(businesses, sign_in):
    """A new business per test, so each starts with no bank connection."""
    tag = f"bank{uuid.uuid4().hex[:8]}"
    b = create_business(f"Business {tag}", people(tag), {e: PASSWORD for e, *_ in people(tag)}, inbox=f"bills@{tag}.test")
    return SimpleNamespace(id=b.id, tag=tag, finance=sign_in(f"finance@{tag}.test"), sign_in=sign_in)


def _connect(biz) -> dict:
    r = biz.finance.post("/api/connections/plaid/connect")
    assert r.status_code == 200, r.text
    return r.json()["counts"]


def _records(bid) -> dict[str, Record]:
    with tenant_session(bid) as db:
        rows = db.execute(select(Record).where(Record.source == "plaid")).scalars().all()
        db.expunge_all()
    return {r.source_ref.split("-", 1)[1]: r for r in rows}


def _connection(bid) -> Connection:
    with tenant_session(bid) as db:
        c = db.execute(select(Connection).where(Connection.kind == "bank")).scalar_one()
        db.expunge(c)
    return c


def _card(biz) -> dict:
    return next(x for x in biz.finance.get("/api/connections").json()["items"] if x["provider"] == "plaid")


def _later(minutes: int) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


# ── Connecting and reading ─────────────────────────────────────────────────


def test_connect_reads_the_bank_account_and_the_last_30_days(biz, fake_plaid):
    counts = _connect(biz)
    assert counts["accounts"] == 1 and counts["added"] == 2 and counts["skipped"] == 0
    recs = _records(biz.id)
    assert set(recs) == {"k3", "k4"}

    fuel, payout = recs["k3"], recs["k4"]
    assert (fuel.kind, fuel.direction, fuel.amount_minor, fuel.currency) == ("bank_txn", "out", 4799, "GBP")
    assert (payout.direction, payout.amount_minor, payout.status) == ("in", 108810, "posted")
    assert payout.description == "STRIPE PAYMENTS UK PAYOUT 0025" and payout.category is None

    with tenant_session(biz.id) as db:
        accts = db.execute(select(Account).where(Account.source == "plaid")).scalars().all()
        assert [(a.name, a.mask, a.balance_minor, a.currency) for a in accts] == [
            ("Business Current Account", "4417", 2024779, "GBP")]  # the credit card is left out
    c = _connection(biz.id)
    assert c.status == "connected" and c.meta["update_status"] == "INITIAL_UPDATE_COMPLETE"
    assert "access-sandbox" not in str(c.meta) and c.token_enc and "access-sandbox" not in c.token_enc


def test_the_background_schedule_reads_the_rest_of_the_history(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2  # Plaid has finished the history
    assert biz.id in scheduler.poll_banks()
    recs = _records(biz.id)
    assert set(recs) == {"k1", "k2", "k3", "k4"}
    assert recs["k1"].amount_minor == 145080 and recs["k2"].direction == "out"
    assert _connection(biz.id).meta["update_status"] == "HISTORICAL_UPDATE_COMPLETE"
    with tenant_session(biz.id) as db:
        logged = db.execute(select(AuditEntry).where(AuditEntry.event == "connection_synced",
                                                     AuditEntry.actor == "scheduler")).scalars().all()
        assert len(logged) == 1 and logged[0].details["added"] == 2


def test_the_schedule_waits_between_reads_once_the_history_is_in(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2
    scheduler.poll_banks()
    assert biz.id not in scheduler.poll_banks(_later(5))
    assert biz.id in scheduler.poll_banks(_later(16))


def test_quiet_reads_do_not_fill_the_activity_log(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2
    scheduler.poll_banks()
    scheduler.poll_banks(_later(16))
    with tenant_session(biz.id) as db:
        logged = db.execute(select(AuditEntry).where(AuditEntry.actor == "scheduler")).scalars().all()
        assert len(logged) == 1


def test_reading_again_uses_the_saved_place(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2
    biz.finance.post("/api/connections/plaid/sync")
    before = {k: r.id for k, r in _records(biz.id).items()}
    counts = biz.finance.post("/api/connections/plaid/sync").json()["counts"]
    assert counts["added"] == counts["modified"] == counts["removed"] == 0
    assert {k: r.id for k, r in _records(biz.id).items()} == before
    assert _connection(biz.id).cursor == "c2"


def test_changed_and_removed_transactions_follow_the_bank(biz, fake_plaid):
    _connect(biz)
    item = list(fake_plaid.items)[-1]
    fake_plaid.push(modified=[fake_plaid.txn(item, "k3", amount=52.4)],
                    removed=[{"transaction_id": f"{item}-k4", "account_id": f"{item}-acc"}])
    counts = biz.finance.post("/api/connections/plaid/sync").json()["counts"]
    assert counts["removed"] == 1
    recs = _records(biz.id)
    assert recs["k3"].amount_minor == 5240 and recs["k4"].status == "void"


def test_a_pending_payment_that_posts_keeps_its_record(biz, fake_plaid):
    _connect(biz)
    item = list(fake_plaid.items)[-1]
    fake_plaid.push(added=[fake_plaid.txn(item, "k5p", pending=True, name="ACME SUPPLIES LTD AS-1004", amount=611.4)])
    biz.finance.post("/api/connections/plaid/sync")
    pending = _records(biz.id)["k5p"]
    assert pending.status == "pending"

    fake_plaid.push(added=[fake_plaid.txn(item, "k5", pending_transaction_id=f"{item}-k5p",
                                          name="ACME SUPPLIES LTD AS-1004", amount=611.4)],
                    removed=[{"transaction_id": f"{item}-k5p"}])
    counts = biz.finance.post("/api/connections/plaid/sync").json()["counts"]
    recs = _records(biz.id)
    assert "k5p" not in recs and recs["k5"].id == pending.id and recs["k5"].status == "posted"
    assert counts["carried_over"] == 1


def test_a_change_at_the_bank_while_paging_starts_the_read_again(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2
    item = list(fake_plaid.items)[-1]
    fake_plaid.push(added=[fake_plaid.txn(item, "k6")])
    fake_plaid.fail_once["c2"] = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
    r = biz.finance.post("/api/connections/plaid/sync")
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["added"] == 3  # k1, k2, k6 counted once each, though c1 was read twice
    assert set(_records(biz.id)) == {"k1", "k2", "k3", "k4", "k6"}
    assert _connection(biz.id).cursor == "c3"


def test_malformed_transactions_are_skipped_and_counted(biz, fake_plaid):
    _connect(biz)
    item = list(fake_plaid.items)[-1]
    fake_plaid.push(added=[fake_plaid.txn(item, "k7", amount="lots"), fake_plaid.txn(item, "k8", iso_currency_code=None),
                           fake_plaid.txn(item, "k9", transaction_id="bad id; drop"), fake_plaid.txn(item, "k10")])
    counts = biz.finance.post("/api/connections/plaid/sync").json()["counts"]
    assert counts["skipped"] == 3
    recs = _records(biz.id)
    assert "k10" in recs and not {"k7", "k8"} & set(recs)


# ── Expired connections and reconnecting ───────────────────────────────────


def test_expired_bank_login_asks_the_person_to_reconnect(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["login_required"] = True
    r = biz.finance.post("/api/connections/plaid/sync")
    assert r.status_code == 409 and r.json()["detail"] == "The bank connection has expired. Reconnect."
    card = _card(biz)
    assert card["status"] == "expired" and card["error"] == "The bank connection has expired. Reconnect."


def test_the_schedule_marks_an_expired_bank_and_then_leaves_it_alone(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["login_required"] = True
    assert biz.id in scheduler.poll_banks()
    assert _card(biz)["status"] == "expired"
    item = list(fake_plaid.items)[-1]
    reads = fake_plaid.reads.count(item)
    assert biz.id not in scheduler.poll_banks(_later(60))
    assert fake_plaid.reads.count(item) == reads


def test_the_schedule_shows_a_bank_that_is_down_and_tries_again(biz, fake_plaid, monkeypatch):
    _connect(biz)

    def down(path, body):
        raise plaid_conn.PlaidError("INSTITUTION_NOT_RESPONDING", "down")

    monkeypatch.setattr(plaid_conn, "_post", down)
    scheduler.poll_banks()
    card = _card(biz)
    assert card["status"] == "error" and card["error"] == "The bank didn't respond. Try again in a minute."


def test_reconnecting_carries_records_over_instead_of_duplicating_them(biz, fake_plaid):
    _connect(biz)
    fake_plaid.item["released"] = 2
    biz.finance.post("/api/connections/plaid/sync")
    before = {k: r.id for k, r in _records(biz.id).items()}
    first = list(fake_plaid.items)[0]
    fake_plaid.items[first]["login_required"] = True
    biz.finance.post("/api/connections/plaid/sync")

    # Connecting again makes a new link with new ids; the rent payment has gone from the bank's history
    counts = _connect(biz)
    second = list(fake_plaid.items)[-1]
    fake_plaid.items[second]["updates"][1]["added"] = [fake_plaid.txn(second, "k1")]
    assert counts["carried_over"] == 2
    fake_plaid.items[second]["released"] = 2
    counts = biz.finance.post("/api/connections/plaid/sync").json()["counts"]
    assert counts["carried_over"] == 1 and counts["removed"] == 1

    after = _records(biz.id)
    assert {k: r.id for k, r in after.items() if k != "k2"} == {k: v for k, v in before.items() if k != "k2"}
    assert len(after) == 4 and all(r.source_ref.startswith(second) for k, r in after.items() if k != "k2")
    assert after["k2"].status == "void"
    with tenant_session(biz.id) as db:
        assert len(db.execute(select(Account).where(Account.source == "plaid")).scalars().all()) == 1
    assert first in fake_plaid.removed and _card(biz)["status"] == "connected"


def test_syncing_a_bank_that_was_never_connected(biz, fake_plaid):
    r = biz.finance.post("/api/connections/plaid/sync")
    assert r.status_code == 409 and r.json()["detail"] == "Connect the bank account first."
    assert _card(biz)["status"] == "disconnected" and _card(biz)["error"] is None


def test_disconnecting_stops_the_link_and_the_schedule(biz, fake_plaid):
    _connect(biz)
    assert biz.finance.post("/api/connections/plaid/disconnect").status_code == 200
    assert list(fake_plaid.items)[-1] in fake_plaid.removed
    assert biz.id not in scheduler.poll_banks(_later(60))
    assert _records(biz.id)  # the history we already read stays


def test_bookkeeper_cannot_connect_the_bank(biz, fake_plaid):
    books = biz.sign_in(f"books@{biz.tag}.test")
    assert books.post("/api/connections/plaid/connect").status_code == 403
    assert fake_plaid.calls == []


def test_the_schedule_does_not_run_during_tests():
    scheduler.start()
    assert scheduler._scheduler is None
