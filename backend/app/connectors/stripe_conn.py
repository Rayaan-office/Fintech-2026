"""Payment platform: Stripe (sandbox only). Read-only key.

Customers become customers in our records (their email goes into the personal-detail store);
invoices, card payments, fees, refunds, disputes and payouts become ledger records; the Stripe
balance becomes an account.

Every answer is checked against a fixed shape before we use it, and the API version is pinned
so Stripe can't change those shapes under us. Live-mode data is refused.

Notifications must carry a valid Stripe signature, and we don't trust what they say: a
notification only tells us to read the latest from Stripe ourselves.
"""

from datetime import UTC, date, datetime
from typing import Annotated

import stripe
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account, Counterparty
from ..pipeline import counterparties
from ..privacy.redact import mask, store_value, value_fingerprint
from . import outbound
from .common import get_connection, mark_error, mark_synced, route, upsert_record

_s = get_settings()
API = "https://api.stripe.com/v1"
API_VERSION = "2026-09-30.endive"
MAX_PAGES = 20
MAX_LINES = 50
Pence = Annotated[int, Field(ge=0, le=100_000_000_00)]  # anything bigger is not believable here


class StripeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── The shapes we accept (fields we don't use are ignored) ─────────────────


class _Obj(BaseModel, extra="ignore"):
    id: str = Field(min_length=3, max_length=255)
    livemode: bool = False


class Customer(_Obj):
    name: str | None = None
    email: str | None = None
    deleted: bool = False


class InvoiceLine(BaseModel, extra="ignore"):
    description: str | None = None
    quantity: int | None = None
    amount: int


class Invoice(_Obj):
    status: str | None
    currency: str = Field(min_length=3, max_length=3)
    customer: str | None = None
    number: str | None = None
    description: str | None = None
    total: Pence
    amount_remaining: Pence
    created: int
    due_date: int | None = None
    status_transitions: dict = {}
    total_taxes: list[dict] | None = None
    lines: dict = {}


class InvoicePayment(_Obj):
    invoice: str
    status: str
    payment: dict


class Charge(_Obj):
    status: str
    amount: Pence
    amount_refunded: Pence
    currency: str = Field(min_length=3, max_length=3)
    created: int
    customer: str | None = None
    description: str | None = None
    metadata: dict = {}
    payment_intent: str | None = None
    balance_transaction: dict | str | None = None
    disputed: bool = False


class Refund(_Obj):
    status: str | None
    amount: Pence
    currency: str = Field(min_length=3, max_length=3)
    created: int
    charge: str | None = None
    reason: str | None = None
    balance_transaction: dict | str | None = None


class Dispute(_Obj):
    status: str
    amount: Pence
    currency: str = Field(min_length=3, max_length=3)
    created: int
    charge: str
    reason: str | None = None
    balance_transactions: list[dict] = []


class Payout(_Obj):
    status: str
    amount: Pence
    currency: str = Field(min_length=3, max_length=3)
    created: int
    arrival_date: int | None = None
    statement_descriptor: str | None = None
    automatic: bool = True


# ── Reading from Stripe ────────────────────────────────────────────────────


def _key() -> str:
    key = _s.stripe_api_key.get_secret_value()
    if not key.startswith("rk_test_"):
        raise StripeError(0, "Only a sandbox read-only key (rk_test_…) may be used.")
    return key


def _get(path: str, params: dict | None = None) -> dict:
    with outbound.client() as http:
        r = http.get(f"{API}/{path}", params=params or {}, auth=(_key(), ""),
                     headers={"Stripe-Version": API_VERSION})
    if r.status_code != 200:
        try:
            msg = str(r.json().get("error", {}).get("message", ""))[:200]
        except ValueError:
            msg = ""
        raise StripeError(r.status_code, f"Stripe answered {r.status_code}" + (f": {msg}" if msg else ""))
    data = r.json()
    if not isinstance(data, dict) or data.get("livemode"):
        raise StripeError(0, "Stripe sent live-mode data; only the sandbox is allowed.")
    return data


def _list(path: str, model: type[_Obj], params: dict | None = None, skipped: list | None = None):
    """Every object in a Stripe list, checked against its shape. Bad ones are skipped and counted."""
    params = {"limit": 100, **(params or {})}
    for _ in range(MAX_PAGES):
        page = _get(path, params)
        items = page.get("data") or []
        for item in items:
            try:
                obj = model.model_validate(item)
            except ValidationError:
                if skipped is not None:
                    skipped.append(f"{path}:{str(item.get('id', '?'))[:40] if isinstance(item, dict) else '?'}")
                continue
            if obj.livemode:
                raise StripeError(0, "Stripe sent live-mode data; only the sandbox is allowed.")
            yield obj
        if not page.get("has_more") or not items:
            break
        params["starting_after"] = items[-1]["id"]


def _day(ts: int | None) -> date | None:
    return datetime.fromtimestamp(ts, UTC).date() if ts else None


def _cur(code: str) -> str:
    return code.upper()


def _bt(value) -> dict:
    return value if isinstance(value, dict) else {}


# ── Turning Stripe objects into our records ────────────────────────────────


INVOICE_STATUS = {"paid": "paid", "open": "open", "void": "void", "uncollectible": "void"}
REFUND_STATUS = {"succeeded": "posted", "pending": "pending", "requires_action": "pending"}
PAYOUT_STATUS = {"paid": "posted", "pending": "pending", "in_transit": "pending"}


def _customer(db: Session, business_id, cu: Customer) -> Counterparty | None:
    cp = db.execute(select(Counterparty).where(Counterparty.kind == "customer",
                                               Counterparty.external_ids["stripe"].astext == cu.id)).scalar_one_or_none()
    if not cp:
        email = (cu.email or "").strip().lower()
        cp, _ = counterparties.find_or_create(db, business_id, "customer", cu.name or email or cu.id,
                                              email_domain=email.rsplit("@", 1)[-1] if "@" in email else None)
        if not cp:
            return None
        cp.external_ids = {**(cp.external_ids or {}), "stripe": cu.id}
    email = (cu.email or "").strip()
    if "@" in email:
        fp = value_fingerprint("EMAIL", email)
        known = counterparties.latest_details(db, cp.id).get("email")
        if not known or known.get("fp") != fp:
            counterparties.add_version(db, business_id, cp.id, {"email": {
                "fp": fp, "vault": store_value(business_id, "EMAIL", email), "display": mask("EMAIL", email)}},
                "stripe")
        if not cp.email_domain:
            cp.email_domain = email.rsplit("@", 1)[-1].lower()
    return cp


def _invoice(db: Session, business_id, inv: Invoice, cp: Counterparty | None, payments: list[str]) -> None:
    status = INVOICE_STATUS.get(inv.status or "", "open")
    lines = [InvoiceLine.model_validate(line) for line in (inv.lines.get("data") or [])[:MAX_LINES]]
    upsert_record(
        db, business_id, "stripe", inv.id, kind="invoice", direction="in", amount_minor=inv.total,
        open_minor=inv.amount_remaining if status == "open" else 0, currency=_cur(inv.currency),
        date=_day(inv.created), due_date=_day(inv.due_date),
        paid_date=_day(inv.status_transitions.get("paid_at")), status=status,
        counterparty_id=cp.id if cp else None, reference=inv.number,
        description=(inv.description or f"Invoice {inv.number or ''}".strip())[:500], category="sales",
        tax_minor=sum(int(t.get("amount") or 0) for t in inv.total_taxes or []) if inv.total_taxes is not None else None,
        lines=[{"description": (ln.description or "")[:200], "quantity": ln.quantity, "amount_minor": ln.amount}
               for ln in lines],
        external={"stripe_invoice": inv.id, "payment_intents": payments,
                  "written_off": inv.status == "uncollectible"},
    )


def _charge(db: Session, business_id, ch: Charge, cp: Counterparty | None, invoice: tuple[str, str | None] | None) -> int:
    """A card payment and its Stripe fee. Returns the number of records written."""
    bt = _bt(ch.balance_transaction)
    fee = int(bt.get("fee") or 0)
    invoice_id, invoice_number = invoice or (None, None)
    upsert_record(
        db, business_id, "stripe", ch.id, kind="payment_in", direction="in", amount_minor=ch.amount, open_minor=0,
        currency=_cur(ch.currency), date=_day(ch.created), status="posted", counterparty_id=cp.id if cp else None,
        reference=str(ch.metadata.get("invoice_number") or invoice_number or "")[:200] or None,
        description=(ch.description or "Card payment")[:500], category="sales",
        external={"invoice": invoice_id, "payment_intent": ch.payment_intent, "fee_minor": fee,
                  "net_minor": bt.get("net"), "settlement_currency": _cur(bt["currency"]) if bt.get("currency") else None,
                  "refunded_minor": ch.amount_refunded, "disputed": ch.disputed},
    )
    if fee <= 0:
        return 1
    upsert_record(
        db, business_id, "stripe", f"{ch.id}:fee", kind="fee", direction="out", amount_minor=fee, open_minor=0,
        currency=_cur(bt.get("currency") or ch.currency), date=_day(ch.created), status="posted",
        description="Stripe fee for a card payment", category="card_fees", external={"charge": ch.id},
    )
    return 2


def _refund(db: Session, business_id, rf: Refund, cp_id) -> None:
    upsert_record(
        db, business_id, "stripe", rf.id, kind="refund", direction="out", amount_minor=rf.amount, open_minor=0,
        currency=_cur(rf.currency), date=_day(rf.created), status=REFUND_STATUS.get(rf.status or "", "void"),
        counterparty_id=cp_id, description=f"Card refund{f' ({rf.reason})' if rf.reason else ''}"[:500],
        category="refunds", external={"charge": rf.charge, "status": rf.status},
    )


def _dispute(db: Session, business_id, dp: Dispute, cp_id) -> None:
    """A customer's bank took the money back (chargeback). Stripe adds a dispute fee."""
    upsert_record(
        db, business_id, "stripe", dp.id, kind="refund", direction="out", amount_minor=dp.amount, open_minor=0,
        currency=_cur(dp.currency), date=_day(dp.created), status="void" if dp.status == "won" else "posted",
        counterparty_id=cp_id, description=f"Card dispute ({(dp.reason or 'general').replace('_', ' ')})"[:500],
        category="disputes", external={"charge": dp.charge, "dispute_status": dp.status},
    )
    fee = sum(int(b.get("fee") or 0) for b in dp.balance_transactions if isinstance(b, dict))
    if fee > 0:
        upsert_record(
            db, business_id, "stripe", f"{dp.id}:fee", kind="fee", direction="out", amount_minor=fee, open_minor=0,
            currency=_cur(dp.currency), date=_day(dp.created), status="posted",
            description="Stripe dispute fee", category="card_fees", external={"dispute": dp.id},
        )


def _payout(db: Session, business_id, po: Payout) -> None:
    upsert_record(
        db, business_id, "stripe", po.id, kind="payout", direction="in", amount_minor=po.amount, open_minor=po.amount,
        currency=_cur(po.currency), date=_day(po.created), due_date=_day(po.arrival_date),
        status=PAYOUT_STATUS.get(po.status, "void"),
        description=f"Stripe payout {po.statement_descriptor or ''}".strip()[:500], category="transfer",
        external={"payout_id": po.id, "status": po.status, "automatic": po.automatic},
    )


def _balance(db: Session, business_id) -> int:
    bal = _get("balance")
    amounts: dict[str, list[int]] = {}
    for kind in ("available", "pending"):
        for b in bal.get(kind) or []:
            cur = str(b.get("currency", ""))
            if len(cur) != 3 or not isinstance(b.get("amount"), int):
                continue
            amounts.setdefault(cur, [0, 0])[0 if kind == "available" else 1] += b["amount"]
    for cur, (available, pending) in amounts.items():
        ext = f"balance:{cur}"
        acct = db.execute(select(Account).where(Account.source == "stripe", Account.external_id == ext)).scalar_one_or_none()
        if not acct:
            acct = Account(business_id=business_id, source="stripe", external_id=ext,
                           name=f"Stripe balance ({cur.upper()})")
            db.add(acct)
        acct.currency = cur.upper()
        acct.balance_minor = available + pending
        acct.available_minor = available
        acct.as_of = datetime.now(UTC)
    return len(amounts)


# ── Connect and sync ───────────────────────────────────────────────────────


def connect(db: Session, business_id) -> dict:
    _get("balance")  # proves the key works (and refuses live mode)
    c = get_connection(db, business_id, "stripe")
    c.meta = {**(c.meta or {}), "mode": "sandbox", "api_version": API_VERSION}
    # Sandbox events from `stripe listen` don't name an account, so one Stripe account per app
    route(db, "stripe", "self", business_id)
    return sync(db, business_id)


def sync(db: Session, business_id) -> dict:
    """Read everything again from Stripe. Upserts, so running it twice changes nothing."""
    c = get_connection(db, business_id, "stripe")
    counts = {"customers": 0, "invoices": 0, "payments": 0, "fees": 0, "refunds": 0, "disputes": 0, "payouts": 0}
    skipped: list[str] = []
    try:
        customers: dict[str, Counterparty] = {}
        for cu in _list("customers", Customer, skipped=skipped):
            if cu.deleted:
                continue
            cp = _customer(db, business_id, cu)
            if cp:
                customers[cu.id] = cp
                counts["customers"] += 1

        # Which card payment paid which invoice
        paid_by: dict[str, list[str]] = {}
        for ip in _list("invoice_payments", InvoicePayment, skipped=skipped):
            pi = ip.payment.get("payment_intent") or ip.payment.get("charge")
            if ip.status == "paid" and isinstance(pi, str):
                paid_by.setdefault(ip.invoice, []).append(pi)
        by_payment: dict[str, tuple[str, str | None]] = {}
        for inv in _list("invoices", Invoice, skipped=skipped):
            if inv.status in (None, "draft"):
                continue
            payments = paid_by.get(inv.id, [])
            for pi in payments:
                by_payment[pi] = (inv.id, inv.number)
            _invoice(db, business_id, inv, customers.get(inv.customer or ""), payments)
            counts["invoices"] += 1

        charge_party: dict[str, object] = {}
        for ch in _list("charges", Charge, {"expand[]": "data.balance_transaction"}, skipped=skipped):
            cp = customers.get(ch.customer or "")
            charge_party[ch.id] = cp.id if cp else None
            if ch.status != "succeeded":
                continue
            written = _charge(db, business_id, ch, cp, by_payment.get(ch.payment_intent or "") or by_payment.get(ch.id))
            counts["payments"] += 1
            counts["fees"] += written - 1

        for rf in _list("refunds", Refund, skipped=skipped):
            _refund(db, business_id, rf, charge_party.get(rf.charge or ""))
            counts["refunds"] += 1

        for dp in _list("disputes", Dispute, skipped=skipped):
            _dispute(db, business_id, dp, charge_party.get(dp.charge))
            counts["disputes"] += 1

        for po in _list("payouts", Payout, skipped=skipped):
            _payout(db, business_id, po)
            counts["payouts"] += 1

        counts["balances"] = _balance(db, business_id)
        if skipped:
            counts["skipped"] = len(skipped)
        mark_synced(db, c, counts)
    except StripeError as exc:
        mark_error(db, c, exc.message, expired=exc.status == 401)
        raise
    except Exception as exc:
        mark_error(db, c, f"Stripe sync failed ({type(exc).__name__})")
        raise
    return counts


# ── Notifications ──────────────────────────────────────────────────────────

# Notifications that mean something we keep has changed; others are acknowledged and ignored
RELEVANT = ("customer.", "invoice.", "invoice_payment.", "charge.", "payment_intent.", "refund.", "payout.",
            "balance.available")


def relevant(event_type: str) -> bool:
    return event_type.startswith(RELEVANT)


def verify_webhook(payload: bytes, signature: str | None) -> dict:
    """Raises if the signature is missing, wrong or older than five minutes, or the event is live mode."""
    if not signature:
        raise ValueError("missing signature")
    secret = _s.stripe_webhook_secret.get_secret_value()
    if not secret.startswith("whsec_"):
        raise ValueError("no notification secret configured")
    # In stripe-python 16 an Event is no longer a dict, so we work with a plain copy
    event = stripe.Webhook.construct_event(payload, signature, secret, tolerance=300).to_dict()
    if event.get("livemode"):
        raise ValueError("live-mode events are refused")
    if not str(event.get("id", "")).startswith("evt_") or not isinstance(event.get("type"), str):
        raise ValueError("not a Stripe event")
    return event
