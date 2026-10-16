"""Payment platform: Stripe (test mode). Read-only key.

Customers become counterparties; invoices, card payments (with fees) and payouts become
ledger records; the Stripe balance becomes an account. Notifications must carry a valid
Stripe signature, and we re-read the object from Stripe instead of trusting the payload.
"""

from datetime import UTC, date, datetime

import stripe
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account
from ..pipeline.counterparties import find_or_create
from . import outbound
from .common import get_connection, mark_error, mark_synced, route, upsert_record

_s = get_settings()
API = "https://api.stripe.com/v1"
MAX_PAGES = 20


class StripeObject(BaseModel, extra="allow"):
    id: str
    object: str


def _get(path: str, params: dict | None = None) -> dict:
    key = _s.stripe_api_key.get_secret_value()
    if not key.startswith("rk_test_"):
        raise RuntimeError("only a test-mode restricted key may be used")
    with outbound.client() as http:
        r = http.get(f"{API}/{path}", params=params or {}, auth=(key, ""))
    if r.status_code != 200:
        raise RuntimeError(f"Stripe answered {r.status_code}")
    return r.json()


def _list(path: str, params: dict | None = None):
    params = {"limit": 100, **(params or {})}
    for _ in range(MAX_PAGES):
        page = _get(path, params)
        for item in page.get("data", []):
            StripeObject.model_validate(item)  # check the shape before using it
            yield item
        if not page.get("has_more"):
            break
        params["starting_after"] = page["data"][-1]["id"]


def _day(ts: int | None) -> date | None:
    return datetime.fromtimestamp(ts, UTC).date() if ts else None


def connect(db: Session, business_id) -> dict:
    acct = _get("balance")  # proves the key works
    c = get_connection(db, business_id, "stripe")
    c.status = "connected"
    c.meta = {**(c.meta or {}), "mode": "test", "livemode": acct.get("livemode", False)}
    route(db, "stripe", "self", business_id)
    return sync(db, business_id)


def sync(db: Session, business_id) -> dict:
    c = get_connection(db, business_id, "stripe")
    counts = {"customers": 0, "invoices": 0, "payments": 0, "payouts": 0}
    try:
        customers = {}
        for cu in _list("customers"):
            cp, _ = find_or_create(db, business_id, "customer", cu.get("name") or cu.get("email") or cu["id"])
            cp.external_ids = {**(cp.external_ids or {}), "stripe": cu["id"]}
            customers[cu["id"]] = cp
            counts["customers"] += 1

        for inv in _list("invoices"):
            if inv.get("status") == "draft":
                continue
            cp = customers.get(inv.get("customer"))
            status = {"paid": "paid", "open": "open", "void": "void", "uncollectible": "open"}.get(inv["status"], "open")
            amount = inv.get("total") or inv.get("amount_due") or 0
            upsert_record(
                db, business_id, "stripe", inv["id"], kind="invoice", direction="in", amount_minor=amount,
                open_minor=(inv.get("amount_remaining") or 0) if status != "void" else 0,
                currency=inv.get("currency", "gbp").upper(), date=_day(inv.get("created")),
                due_date=_day(inv.get("due_date")),
                paid_date=_day((inv.get("status_transitions") or {}).get("paid_at")),
                status=status, counterparty_id=cp.id if cp else None, reference=inv.get("number"),
                description=(inv.get("description") or f"Invoice {inv.get('number') or ''}")[:500],
                category="sales", tax_minor=inv.get("tax"),
                external={"stripe_invoice": inv["id"], "hosted_url_present": bool(inv.get("hosted_invoice_url"))},
            )
            counts["invoices"] += 1

        for ch in _list("charges", {"expand[]": "data.balance_transaction"}):
            if ch.get("status") != "succeeded":
                continue
            bt = ch.get("balance_transaction") or {}
            fee = bt.get("fee", 0) if isinstance(bt, dict) else 0
            cp = customers.get(ch.get("customer"))
            upsert_record(
                db, business_id, "stripe", ch["id"], kind="payment_in", direction="in", amount_minor=ch["amount"],
                open_minor=0, currency=ch.get("currency", "gbp").upper(), date=_day(ch.get("created")),
                status="posted", counterparty_id=cp.id if cp else None,
                reference=(ch.get("metadata") or {}).get("invoice_number") or ch.get("description"),
                description=(ch.get("description") or "Card payment")[:500], category="sales",
                external={"invoice": ch.get("invoice"), "fee_minor": fee,
                          "net_minor": bt.get("net") if isinstance(bt, dict) else None,
                          "refunded_minor": ch.get("amount_refunded", 0), "disputed": ch.get("disputed", False)},
            )
            counts["payments"] += 1

        for po in _list("payouts"):
            upsert_record(
                db, business_id, "stripe", po["id"], kind="payout", direction="in", amount_minor=po["amount"],
                open_minor=po["amount"], currency=po.get("currency", "gbp").upper(), date=_day(po.get("created")),
                due_date=_day(po.get("arrival_date")), status="posted" if po["status"] == "paid" else "pending",
                description=f"Stripe payout {po.get('statement_descriptor') or ''}".strip()[:500], category="transfer",
                external={"payout_id": po["id"], "status": po["status"]},
            )
            counts["payouts"] += 1

        bal = _get("balance")
        for i, b in enumerate(bal.get("available", [])):
            pending = sum(p["amount"] for p in bal.get("pending", []) if p["currency"] == b["currency"])
            acct = db.query(Account).filter_by(source="stripe", external_id=f"balance:{b['currency']}").one_or_none()
            if not acct:
                acct = Account(business_id=business_id, source="stripe", external_id=f"balance:{b['currency']}",
                               name=f"Stripe balance ({b['currency'].upper()})")
                db.add(acct)
            acct.currency = b["currency"].upper()
            acct.balance_minor = b["amount"] + pending
            acct.available_minor = b["amount"]
            acct.as_of = datetime.now(UTC)
        mark_synced(db, c, counts)
    except Exception as exc:
        mark_error(db, c, f"Stripe sync failed: {exc}")
        raise
    return counts


def verify_webhook(payload: bytes, signature: str | None) -> dict:
    """Raises if the signature is missing or wrong."""
    if not signature:
        raise ValueError("missing signature")
    event = stripe.Webhook.construct_event(payload, signature, _s.stripe_webhook_secret.get_secret_value())
    if event.get("livemode"):
        raise ValueError("live-mode events are refused")
    return event
