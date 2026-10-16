"""Bank account: Plaid Sandbox, Transactions product only (least data).

The access token is encrypted and never leaves the server. Transactions arrive through
/transactions/sync with a saved cursor, so each sync only fetches what changed.
"""

import json
from datetime import UTC, date, datetime

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account, Record
from ..pipeline.counterparties import find_or_create
from . import outbound
from .common import get_connection, load_secret, mark_error, mark_synced, save_secret, upsert_record

_s = get_settings()
BASE = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}[_s.plaid_env]

# Plaid's categories mapped to ours
CATEGORY = {
    "RENT_AND_UTILITIES": "utilities", "LOAN_PAYMENTS": "loan repayments", "TRANSFER_IN": "transfer",
    "TRANSFER_OUT": "transfer", "GENERAL_SERVICES": "services", "GENERAL_MERCHANDISE": "supplies",
    "FOOD_AND_DRINK": "food and drink", "TRAVEL": "travel", "TRANSPORTATION": "travel", "INCOME": "sales",
    "BANK_FEES": "bank fees", "GOVERNMENT_AND_NON_PROFIT": "tax", "ENTERTAINMENT": "entertainment",
}


class PlaidError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class PlaidTxn(BaseModel, extra="ignore"):
    transaction_id: str
    account_id: str
    amount: float
    iso_currency_code: str | None = "GBP"
    date: date
    name: str | None = None
    merchant_name: str | None = None
    pending: bool = False
    personal_finance_category: dict | None = None


def _post(path: str, body: dict) -> dict:
    payload = {"client_id": _s.plaid_client_id, "secret": _s.plaid_secret.get_secret_value(), **body}
    with outbound.client(timeout=30) as http:
        r = http.post(f"{BASE}{path}", json=payload)
    data = r.json()
    if r.status_code != 200:
        raise PlaidError(data.get("error_code", str(r.status_code)), data.get("error_message", "")[:200])
    return data


def connect_sandbox(db: Session, business_id, custom_user: dict | None = None,
                    institution_id: str = "ins_118510") -> dict:
    """Sandbox shortcut that skips the Plaid Link screen. A custom test user supplies realistic transactions."""
    opts: dict = {"transactions": {"days_requested": 365}}
    if custom_user:
        opts.update({"override_username": "user_custom", "override_password": json.dumps(custom_user)})
    pub = _post("/sandbox/public_token/create", {"institution_id": institution_id,
                                                 "initial_products": _s.plaid_products.split(","), "options": opts})
    ex = _post("/item/public_token/exchange", {"public_token": pub["public_token"]})
    c = get_connection(db, business_id, "plaid")
    save_secret(c, {"access_token": ex["access_token"], "item_id": ex["item_id"]})
    c.cursor = None
    c.status = "connected"
    c.meta = {**(c.meta or {}), "institution_id": institution_id, "mode": "sandbox"}
    db.flush()
    return sync(db, business_id)


def sync(db: Session, business_id) -> dict:
    c = get_connection(db, business_id, "plaid")
    secret = load_secret(c)
    if not secret:
        raise RuntimeError("bank not connected")
    token = secret["access_token"]
    counts = {"accounts": 0, "added": 0, "modified": 0, "removed": 0}
    try:
        accts = _post("/accounts/balance/get", {"access_token": token})["accounts"]
        by_plaid: dict[str, Account] = {}
        for a in accts:
            if a.get("type") not in ("depository",):  # business current and savings accounts only
                continue
            row = db.execute(select(Account).where(Account.source == "plaid",
                                                   Account.external_id == a["account_id"])).scalar_one_or_none()
            if not row:
                row = Account(business_id=business_id, source="plaid", external_id=a["account_id"],
                              name=a.get("name") or "Bank account")
                db.add(row)
            bal = a.get("balances") or {}
            row.mask = a.get("mask")
            row.currency = bal.get("iso_currency_code") or "GBP"
            row.balance_minor = round((bal.get("current") or 0) * 100)
            row.available_minor = round(bal["available"] * 100) if bal.get("available") is not None else None
            row.as_of = datetime.now(UTC)
            db.flush()
            by_plaid[a["account_id"]] = row
            counts["accounts"] += 1

        cursor = c.cursor
        for _ in range(50):
            page = _post("/transactions/sync", {"access_token": token, "cursor": cursor or "", "count": 250} if cursor
                         else {"access_token": token, "count": 250})
            for kind in ("added", "modified"):
                for raw in page.get(kind, []):
                    t = PlaidTxn.model_validate(raw)
                    if t.account_id not in by_plaid:
                        continue
                    _save_txn(db, business_id, t, by_plaid[t.account_id])
                    counts[kind] += 1
            for gone in page.get("removed", []):
                r = db.execute(select(Record).where(Record.source == "plaid",
                                                    Record.source_ref == gone["transaction_id"])).scalar_one_or_none()
                if r:
                    r.status = "void"
                    counts["removed"] += 1
            cursor = page.get("next_cursor")
            if not page.get("has_more"):
                break
        c.cursor = cursor
        mark_synced(db, c, counts)
    except PlaidError as e:
        mark_error(db, c, "The bank connection has expired. Reconnect." if e.code == "ITEM_LOGIN_REQUIRED"
                   else f"Bank sync failed ({e.code}).", expired=e.code == "ITEM_LOGIN_REQUIRED")
        raise
    return counts


def _save_txn(db: Session, business_id, t: PlaidTxn, acct: Account) -> None:
    # Plaid: positive amount = money out of the account
    direction = "out" if t.amount > 0 else "in"
    minor = round(abs(t.amount) * 100)
    label = t.merchant_name or t.name or "Bank transaction"
    cp = None
    if t.merchant_name:
        cp, _ = find_or_create(db, business_id, "supplier" if direction == "out" else "customer", t.merchant_name)
    pfc = (t.personal_finance_category or {}).get("primary", "")
    desc = (t.name or label)[:500]
    upsert_record(
        db, business_id, "plaid", t.transaction_id, kind="bank_txn", direction=direction, amount_minor=minor,
        open_minor=0, currency=(t.iso_currency_code or "GBP").upper(), date=t.date,
        status="pending" if t.pending else "posted", counterparty_id=cp.id if cp else None, account_id=acct.id,
        reference=desc[:200], description=desc, category=CATEGORY.get(pfc) or (cp.category if cp else None),
        external={"payout_id": _payout_ref(desc)},
    )


def _payout_ref(desc: str) -> str | None:
    """Stripe payouts show as 'STRIPE PAYOUT po_…' on our demo statements."""
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
