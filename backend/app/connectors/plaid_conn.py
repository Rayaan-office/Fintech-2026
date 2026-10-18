"""Bank account: Plaid Sandbox (UK), Transactions product only (least data).

The access token is encrypted and never leaves the server. Transactions arrive through
/transactions/sync with a saved cursor, so each sync only fetches what changed. Plaid sends
the last 30 days within a second of connecting and the rest of the history a few seconds
later; our background poller keeps reading until the history is complete.

We have no public address (no tunnel), so Plaid can't notify us. The poller in
app/scheduler.py reads every connected bank on a schedule instead.
"""

import json
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..analytics import methods
from ..config import get_settings
from ..models import Account, Record
from ..pipeline.counterparties import find_or_create
from . import outbound
from .common import get_connection, load_secret, mark_synced, route, save_secret, upsert_record

_s = get_settings()
BASE = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}[_s.plaid_env]
# Royal Bank of Plaid: Plaid's UK test bank. Custom test users need a bank without an OAuth screen.
SANDBOX_BANK = "ins_117650"
MAX_PAGES = 40
PAGE_SIZE = 500
HISTORY_DONE = "HISTORICAL_UPDATE_COMPLETE"

# Plaid's categories mapped to ours
CATEGORY = {
    "RENT_AND_UTILITIES": "utilities", "LOAN_PAYMENTS": "loan repayments", "TRANSFER_IN": "transfer",
    "TRANSFER_OUT": "transfer", "GENERAL_SERVICES": "services", "GENERAL_MERCHANDISE": "supplies",
    "FOOD_AND_DRINK": "food and drink", "TRAVEL": "travel", "TRANSPORTATION": "travel", "INCOME": "sales",
    "BANK_FEES": "bank fees", "GOVERNMENT_AND_NON_PROFIT": "tax", "ENTERTAINMENT": "entertainment",
}
# The person has to sign in to the bank again; retrying won't help
EXPIRED = {"ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN", "ITEM_NOT_FOUND", "ACCESS_NOT_GRANTED"}

Id = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")]
Pounds = Annotated[Decimal, Field(ge=-100_000_000, le=100_000_000)]


class PlaidError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}")
        self.code = code

    @property
    def expired(self) -> bool:
        return self.code in EXPIRED

    def for_person(self) -> str:
        if self.code == "NOT_CONNECTED":
            return "Connect the bank account first."
        if self.expired:
            return "The bank connection has expired. Reconnect."
        return "The bank didn't respond. Try again in a minute."


class Balances(BaseModel, extra="ignore"):
    current: Pounds | None = None
    available: Pounds | None = None
    iso_currency_code: str | None = Field(None, pattern=r"^[A-Z]{3}$")


class PlaidAccount(BaseModel, extra="ignore"):
    account_id: Id
    name: str | None = Field(None, max_length=200)
    mask: str | None = Field(None, max_length=10)
    type: str
    balances: Balances


class PlaidTxn(BaseModel, extra="ignore"):
    transaction_id: Id
    account_id: Id
    amount: Pounds
    iso_currency_code: str = Field(pattern=r"^[A-Z]{3}$")  # missing for crypto-style currencies: skipped
    date: date
    name: str | None = None
    merchant_name: str | None = None
    pending: bool = False
    pending_transaction_id: Id | None = None
    personal_finance_category: dict | None = None
    payment_channel: str | None = Field(None, max_length=20)  # online | in store | other


class Removed(BaseModel, extra="ignore"):
    transaction_id: Id


def _post(path: str, body: dict) -> dict:
    secret = _s.plaid_secret.get_secret_value()
    if not _s.plaid_client_id or not secret:
        raise PlaidError("NOT_CONFIGURED", "PLAID_CLIENT_ID and PLAID_SECRET are not set")
    with outbound.client(timeout=30) as http:
        r = http.post(f"{BASE}{path}", json={"client_id": _s.plaid_client_id, "secret": secret, **body})
    try:
        data = r.json()
    except ValueError:
        raise PlaidError(str(r.status_code), "not JSON") from None
    if r.status_code != 200:
        raise PlaidError(data.get("error_code") or str(r.status_code), (data.get("error_message") or "")[:200])
    return data


def _lock(db: Session, business_id) -> None:
    """One bank sync per business at a time, across all our processes."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"plaid:{business_id}"})


def connect_sandbox(db: Session, business_id, custom_user: dict | None = None,
                    institution_id: str = SANDBOX_BANK) -> dict:
    """Sandbox shortcut that skips the Plaid Link screen. A custom test user supplies the story's
    transactions. Connecting again (for example after the connection expired) makes a new link
    with new ids; our records carry over to it instead of being duplicated."""
    _lock(db, business_id)
    opts: dict = {"transactions": {"days_requested": 365}}
    if custom_user:
        opts.update({"override_username": "user_custom", "override_password": json.dumps(custom_user)})
    pub = _post("/sandbox/public_token/create", {"institution_id": institution_id,
                                                 "initial_products": _s.plaid_products.split(","), "options": opts})
    ex = _post("/item/public_token/exchange", {"public_token": pub["public_token"]})
    c = get_connection(db, business_id, "plaid")
    old = load_secret(c).get("access_token")
    save_secret(c, {"access_token": ex["access_token"], "item_id": ex["item_id"]})
    route(db, "plaid", ex["item_id"], business_id)
    c.cursor = None
    c.status = "connected"
    c.last_error = None
    c.meta = {**(c.meta or {}), "institution_id": institution_id, "mode": "sandbox", "item_id": ex["item_id"],
              "update_status": None}
    db.flush()
    counts = sync(db, business_id)
    if old:
        try:  # stop the old link at Plaid, now that the new one works
            _post("/item/remove", {"access_token": old})
        except PlaidError:
            pass
    return counts


def sync(db: Session, business_id) -> dict:
    _lock(db, business_id)
    c = get_connection(db, business_id, "plaid")
    secret = load_secret(c)
    if not secret or c.status == "disconnected":
        raise PlaidError("NOT_CONNECTED")
    token, item = secret["access_token"], secret["item_id"]
    counts = {"accounts": 0, "added": 0, "modified": 0, "removed": 0, "carried_over": 0, "skipped": 0}
    by_plaid = _accounts(db, business_id, token, counts)

    # If the bank changes data while we page through it, Plaid asks us to start again from the
    # cursor we began with; the savepoint throws away the half-read pages.
    for attempt in range(3):
        try:
            with db.begin_nested():
                part = dict.fromkeys(("added", "modified", "removed", "carried_over", "skipped"), 0)
                cursor, status = _read_changes(db, business_id, token, item, c.cursor, by_plaid, part)
            break
        except PlaidError as e:
            if e.code != "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" or attempt == 2:
                raise
    for k, v in part.items():
        counts[k] += v
    if status == HISTORY_DONE:
        counts["removed"] += _void_left_behind(db, item)
    c.cursor = cursor
    c.meta = {**(c.meta or {}), "item_id": item, "update_status": status}
    mark_synced(db, c, counts)
    return counts


def _accounts(db: Session, business_id, token: str, counts: dict) -> dict[str, Account]:
    by_plaid: dict[str, Account] = {}
    for raw in _post("/accounts/get", {"access_token": token})["accounts"]:
        try:
            a = PlaidAccount.model_validate(raw)
        except ValidationError:
            counts["skipped"] += 1
            continue
        if a.type != "depository":  # business current and savings accounts only
            continue
        row = db.execute(select(Account).where(Account.source == "plaid",
                                               Account.external_id == a.account_id)).scalar_one_or_none()
        if not row and a.mask:  # same account seen through an earlier link
            row = db.execute(select(Account).where(Account.source == "plaid", Account.mask == a.mask,
                                                   Account.name == (a.name or "Bank account"))).scalar_one_or_none()
            if row:
                row.external_id = a.account_id
        if not row:
            row = Account(business_id=business_id, source="plaid", external_id=a.account_id,
                          name=a.name or "Bank account")
            db.add(row)
        b = a.balances
        row.mask = a.mask
        row.currency = b.iso_currency_code or "GBP"
        row.balance_minor = _pence(b.current or 0)
        row.available_minor = _pence(b.available) if b.available is not None else None
        row.as_of = datetime.now(UTC)
        db.flush()
        by_plaid[a.account_id] = row
        counts["accounts"] += 1
    return by_plaid


def _read_changes(db: Session, business_id, token: str, item: str, cursor: str | None,
                  by_plaid: dict[str, Account], counts: dict) -> tuple[str | None, str]:
    status = "TRANSACTIONS_UPDATE_STATUS_UNKNOWN"
    for _ in range(MAX_PAGES):
        page = _post("/transactions/sync", {"access_token": token, "count": PAGE_SIZE,
                                            **({"cursor": cursor} if cursor else {})})
        status = page.get("transactions_update_status") or status
        for kind in ("added", "modified"):
            for raw in page.get(kind, []):
                try:
                    t = PlaidTxn.model_validate(raw)
                except ValidationError:
                    counts["skipped"] += 1
                    continue
                if t.account_id not in by_plaid:
                    continue
                if _save_txn(db, business_id, t, by_plaid[t.account_id], item):
                    counts["carried_over"] += 1
                counts[kind] += 1
        for raw in page.get("removed", []):
            try:
                gone = Removed.model_validate(raw)
            except ValidationError:
                counts["skipped"] += 1
                continue
            r = db.execute(select(Record).where(Record.source == "plaid",
                                                Record.source_ref == gone.transaction_id)).scalar_one_or_none()
            if r and r.status != "void":
                r.status = "void"
                counts["removed"] += 1
        # An empty cursor means Plaid has nothing for us yet; keep the one we had
        cursor = page.get("next_cursor") or cursor
        if not page.get("has_more"):
            break
    return cursor, status


def _pence(pounds: Decimal | float) -> int:
    return int((Decimal(str(pounds)) * 100).quantize(Decimal(1), ROUND_HALF_UP))


def _save_txn(db: Session, business_id, t: PlaidTxn, acct: Account, item: str) -> bool:
    """Save one transaction. Returns True if it took over a record we already had under another id."""
    # Plaid: positive amount = money out of the account
    direction = "out" if t.amount > 0 else "in"
    minor = abs(_pence(t.amount))
    desc = (t.name or t.merchant_name or "Bank transaction")[:500]
    carried = _carry_over(db, t, acct, item, direction, minor, desc)
    cp = None
    if t.merchant_name:
        cp, _ = find_or_create(db, business_id, "supplier" if direction == "out" else "customer", t.merchant_name)
    pfc = t.personal_finance_category or {}
    category = CATEGORY.get(pfc.get("primary", "")) if pfc.get("confidence_level") != "LOW" else None
    upsert_record(
        db, business_id, "plaid", t.transaction_id, kind="bank_txn", direction=direction, amount_minor=minor,
        open_minor=0, currency=t.iso_currency_code, date=t.date,
        status="pending" if t.pending else "posted", counterparty_id=cp.id if cp else None, account_id=acct.id,
        reference=desc[:200], description=desc, category=category or (cp.category if cp else None),
        method=methods.from_bank(desc, t.iso_currency_code, acct.currency, t.payment_channel),
        external={"item": item, "payout_id": _payout_ref(desc), "channel": t.payment_channel},
    )
    return carried


def _carry_over(db: Session, t: PlaidTxn, acct: Account, item: str, direction: str, minor: int, desc: str) -> bool:
    """Give an existing record the new transaction id, so matches and approvals on it are kept:
    - a pending transaction that has now posted (Plaid gives the posted one a new id);
    - the same transaction seen through an earlier bank link (after reconnecting)."""
    if db.execute(select(Record.id).where(Record.source == "plaid", Record.source_ref == t.transaction_id)).first():
        return False
    old = None
    if t.pending_transaction_id:
        old = db.execute(select(Record).where(Record.source == "plaid",
                                              Record.source_ref == t.pending_transaction_id)).scalar_one_or_none()
    if not old:
        old = db.execute(select(Record).where(
            Record.source == "plaid", Record.account_id == acct.id, Record.date == t.date,
            Record.amount_minor == minor, Record.direction == direction, Record.description == desc,
            Record.external["item"].astext.is_distinct_from(item),
        ).limit(1)).scalar_one_or_none()
    if not old:
        return False
    old.source_ref = t.transaction_id
    db.flush()
    return True


def _void_left_behind(db: Session, item: str) -> int:
    """Once the full history has arrived through a new link, records from the old link that
    weren't carried over no longer exist at the bank."""
    rows = db.execute(select(Record).where(Record.source == "plaid", Record.status != "void",
                                           Record.external["item"].astext.is_distinct_from(item))).scalars().all()
    for r in rows:
        r.status = "void"
    return len(rows)


def _payout_ref(desc: str) -> str | None:
    """Stripe payouts show as 'STRIPE PAYOUT po_…' on some statements."""
    for token in desc.replace(",", " ").split():
        if token.startswith("po_"):
            return token
    return None


def disconnect(db: Session, business_id) -> None:
    c = get_connection(db, business_id, "plaid")
    secret = load_secret(c)
    if secret:
        try:
            _post("/item/remove", {"access_token": secret["access_token"]})
        except PlaidError:
            pass
    c.token_enc = None
    c.cursor = None
    c.status = "disconnected"
    c.meta = {**(c.meta or {}), "update_status": None}
