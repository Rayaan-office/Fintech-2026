"""Our single view of the money: cash today, what is owed each way, and what each bank line is.

Every figure is in the business's own currency. Accounts and items in another currency are
left out of the totals and listed, because we hold no exchange rates.

Bank lines get one of these groups, so nothing is counted twice:
  settles   - the same money as an invoice, bill or payout we already have (from matching)
  payout    - card sales arriving from the payment platform
  tax       - payments to or from the tax office
  financing - loan repayments and similar
  salaries, rent, everyday - everything else, by what it is
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import Account, Business, Counterparty, Match, Record

PLATFORMS = ("stripe", "sumup", "square", "paypal", "zettle", "worldpay")
GROUP_WORDS = {
    "tax": ("hmrc", "vat", "paye", "corporation tax", "inland revenue"),
    "financing": ("loan", "finance", "lending", "capital", "mortgage", "lease"),
    "salaries": ("payroll", "salary", "salaries", "wages", "pension"),
    "rent": ("rent", "landlord"),
}
GROUP_CATEGORIES = {"tax": "tax", "loan repayments": "financing", "transfer": "transfer"}


def business(db: Session) -> Business:
    """The business this tenant session belongs to (see db.tenant_session)."""
    bid = db.execute(text("SELECT current_setting('app.business_id', true)")).scalar()
    biz = db.get(Business, UUID(bid)) if bid else None
    if not biz:
        raise LookupError("not inside a business's session")
    return biz


def cash(db: Session) -> dict:
    """Cash today across every connected bank account and payment-platform balance."""
    biz = business(db)
    accounts = db.execute(select(Account).order_by(Account.source, Account.name)).scalars().all()
    rows, total, as_of = [], 0, None
    for a in accounts:
        counted = a.currency == biz.currency
        if counted:
            total += a.balance_minor
            as_of = max(as_of, a.as_of) if as_of else a.as_of
        rows.append({"id": str(a.id), "name": a.name, "source": a.source, "mask": a.mask, "currency": a.currency,
                     "balance_minor": a.balance_minor, "counted": counted})
    return {"currency": biz.currency, "balance_minor": total, "as_of": (as_of or datetime.now()).isoformat(),
            "accounts": rows, "platform_minor": sum(a.balance_minor for a in accounts
                                                     if a.currency == biz.currency and a.source != "plaid"),
            "left_out": [r for r in rows if not r["counted"]]}


def open_items(db: Session, kind: str) -> tuple[list[Record], list[Record]]:
    """Unpaid invoices or bills: (in the business currency, in other currencies)."""
    biz = business(db)
    rows = db.execute(select(Record).where(Record.kind == kind, Record.status == "open",
                                           Record.open_minor > 0)).scalars().all()
    return [r for r in rows if r.currency == biz.currency], [r for r in rows if r.currency != biz.currency]


def names(db: Session) -> dict:
    return {c.id: c.display_name for c in db.execute(select(Counterparty)).scalars()}


def terms(db: Session) -> dict:
    return {c.id: c.payment_terms_days for c in db.execute(select(Counterparty)).scalars()}


def due(r: Record, terms_days: dict) -> date:
    if r.due_date:
        return r.due_date
    days = terms_days.get(r.counterparty_id)
    return date.fromordinal(r.date.toordinal() + (days if days is not None else 30))


@dataclass
class Line:
    record: Record
    group: str
    category: str
    party_id: object = None  # the customer or supplier, when we know it
    linked_kind: str | None = None  # invoice | bill | payout, for "settles"
    key: str = ""  # the same payee or payer over time, for spotting repeating items
    extra: dict = field(default_factory=dict)


def _words(text: str | None) -> str:
    """A bank line's text without numbers, references and dates: 'PAYROLL BACS 0928' -> 'payroll bacs'."""
    words = [w for w in re.findall(r"[a-z]+[a-z0-9]*", (text or "").lower()) if not any(ch.isdigit() for ch in w)]
    return " ".join(w for w in words if w not in ("ref", "dd", "so", "card", "bacs", "fp", "inv"))[:80] or "other"


def _group(r: Record) -> str:
    text = (r.description or "").lower()
    if any(p in text for p in PLATFORMS) and r.direction == "in":
        return "payout"
    for group, words in GROUP_WORDS.items():
        if any(re.search(rf"\b{re.escape(w)}\b", text) for w in words):
            return group
    return GROUP_CATEGORIES.get((r.category or "").lower(), "everyday")


def bank_lines(db: Session, since: date | None = None, until: date | None = None) -> list[Line]:
    """Every bank line in the business currency, with its group."""
    biz = business(db)
    q = select(Record).where(Record.kind == "bank_txn", Record.status != "void", Record.currency == biz.currency)
    if since:
        q = q.where(Record.date >= since)
    if until:
        q = q.where(Record.date <= until)
    rows = db.execute(q.order_by(Record.date)).scalars().all()
    ids = {r.id for r in rows}
    links: dict = {}
    for left, right in db.execute(select(Match.left_id, Match.right_id).where(Match.status == "accepted")).all():
        if right in ids:
            links[right] = left
    targets = {t.id: t for t in db.execute(select(Record).where(Record.id.in_(set(links.values())))).scalars()} \
        if links else {}
    out = []
    for r in rows:
        t = targets.get(links.get(r.id))
        if t:
            out.append(Line(r, "settles", t.category or ("sales" if t.kind == "invoice" else "other"),
                            t.counterparty_id, t.kind, f"party:{t.counterparty_id or _words(r.description)}:{r.direction}"))
            continue
        g = _group(r)
        category = {"salaries": "salaries", "rent": "rent", "tax": "tax", "financing": "loan repayments",
                    "payout": "card sales"}.get(g) or (r.category or "other")
        out.append(Line(r, g, category, r.counterparty_id, None, f"text:{_words(r.description)}:{r.direction}"))
    return out


def tax_rate(db: Session) -> float:
    """The share of VAT in what customers pay, from our invoices (0.2 for 20% VAT). 0 if none."""
    biz = business(db)
    rows = db.execute(select(Record.amount_minor, Record.tax_minor).where(
        Record.kind == "invoice", Record.status != "void", Record.currency == biz.currency,
        Record.tax_minor.is_not(None), Record.amount_minor > 0)).all()
    gross = sum(a for a, _ in rows)
    tax = sum(t for _, t in rows)
    return round(tax / (gross - tax), 4) if gross > tax > 0 else 0.0


def net(r: Record) -> int:
    """Amount before VAT."""
    return r.amount_minor - (r.tax_minor or 0)
