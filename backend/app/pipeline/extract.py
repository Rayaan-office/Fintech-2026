"""The AI's fixed form, and our code's checks on what it filled in.

The AI can only fill in this form. It cannot call tools or take any action, so hidden
instructions in a document have nothing to act with. Every figure must add up and must
appear in the document text, or the form is rejected.
"""

import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from ..privacy.detectors import PLACEHOLDER_RE

PROMPT_VERSION = "extract-v1"

INSTRUCTIONS = """You read business documents (bills, invoices, receipts, payment notices) and fill in a form.
Rules:
- Copy values exactly as they appear. Do not calculate, guess or invent anything.
- Amounts: digits with a dot for decimals and no currency symbol or thousands separator, e.g. 1240.00. Use "" if absent.
- Dates: YYYY-MM-DD. The document may write dates day-first (UK style). Use "" if absent.
- currency: the ISO code, e.g. GBP, USD, EUR.
- doc_type: "bill" if the business must pay it, "invoice" if the business issued it to its customer,
  "receipt" if already paid, "payment_notice" for a remittance or payment confirmation, "credit_note", or "other".
- counterparty_name: the other business or person (the supplier on a bill), not the business receiving it.
- reference: the invoice or document number.
- For hidden values written as placeholders like [BANK_ACCOUNT_1], copy the placeholder exactly.
- category_hint: one or two words for what was bought, e.g. "stock", "rent", "software", "utilities"."""


class LineItem(BaseModel):
    description: str
    quantity: str
    unit_price: str
    amount: str


class DocumentForm(BaseModel):
    doc_type: Literal["bill", "invoice", "receipt", "payment_notice", "credit_note", "other"]
    counterparty_name: str
    issue_date: str
    due_date: str
    currency: str
    reference: str
    line_items: list[LineItem] = Field(max_length=200)
    subtotal: str
    tax: str
    total: str
    payment_bank_account: str
    payment_sort_code: str
    contact_email: str
    contact_phone: str
    address: str
    category_hint: str


KEY_FIELDS = ("total", "currency", "due_date", "counterparty_name")
CURRENCIES = {"GBP", "USD", "EUR", "AED", "CAD", "AUD", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "INR", "SGD", "HKD"}
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December"]


def to_minor(value: str) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    v = re.sub(r"[^\d.\-]", "", str(value).replace(",", ""))
    try:
        return int((Decimal(v) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError):
        return None


def to_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _squash(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def amount_variants(minor: int) -> set[str]:
    neg = minor < 0
    m = abs(minor)
    pounds, pence = divmod(m, 100)
    out = {f"{pounds:,}.{pence:02d}", f"{pounds}.{pence:02d}",
           f"{pounds:,}.{pence:02d}".replace(",", " "),
           f"{pounds:,}".replace(",", ".") + f",{pence:02d}", f"{pounds},{pence:02d}"}
    if pence == 0:
        out |= {f"{pounds:,}", str(pounds)}
    if neg:
        out |= {"-" + v for v in out} | {f"({v})" for v in out}
    return {_squash(v) for v in out}


def date_variants(d: date) -> set[str]:
    mon, mon3 = _MONTHS[d.month - 1], _MONTHS[d.month - 1][:3]
    day_suffix = {1: "st", 2: "nd", 3: "rd", 21: "st", 22: "nd", 23: "rd", 31: "st"}.get(d.day, "th")
    out = set()
    for dd in (f"{d.day:02d}", str(d.day)):
        for mm in (f"{d.month:02d}", str(d.month)):
            for sep in ("/", "-", "."):
                out |= {f"{dd}{sep}{mm}{sep}{d.year}", f"{dd}{sep}{mm}{sep}{d.year % 100:02d}",
                        f"{mm}{sep}{dd}{sep}{d.year}"}
        out |= {f"{dd} {mon} {d.year}", f"{dd} {mon3} {d.year}", f"{mon} {dd}, {d.year}", f"{mon3} {dd}, {d.year}",
                f"{dd}{day_suffix} {mon} {d.year}", f"{dd} {mon3}. {d.year}", f"{dd}-{mon3}-{d.year}"}
    out.add(d.isoformat())
    return {_squash(v) for v in out}


def appears(value_variants: set[str], squashed_text: str) -> bool:
    return any(v and v in squashed_text for v in value_variants)


def check(form: DocumentForm, doc_text: str, placeholders: set[str], today: date | None = None) -> dict:
    """Our code's checks. Returns {"passed": bool, "problems": [plain-words strings]}."""
    today = today or date.today()
    problems: list[str] = []
    st = _squash(doc_text)

    # 1. Required fields
    for f in ("counterparty_name", "currency", "total", "issue_date"):
        if not str(getattr(form, f)).strip():
            problems.append(f"'{f}' is empty but is required.")
    if form.currency and form.currency.upper() not in CURRENCIES:
        problems.append(f"'{form.currency}' is not a currency code we recognise.")

    # 2. The numbers add up
    total, sub, tax = to_minor(form.total), to_minor(form.subtotal), to_minor(form.tax)
    if form.total and total is None:
        problems.append("'total' is not a number.")
    lines = [to_minor(li.amount) for li in form.line_items if li.amount]
    if None in lines:
        problems.append("A line item amount is not a number.")
    lines = [x for x in lines if x is not None]
    expected_sub = sub if sub is not None else ((total - (tax or 0)) if total is not None else None)
    if lines and expected_sub is not None and abs(sum(lines) - expected_sub) > 2:
        problems.append(f"Line items add up to {sum(lines) / 100:.2f}, not the subtotal of {expected_sub / 100:.2f}.")
    if sub is not None and total is not None and abs(sub + (tax or 0) - total) > 2:
        problems.append(f"Subtotal {sub / 100:.2f} plus tax {(tax or 0) / 100:.2f} does not equal total {total / 100:.2f}.")

    # 3. Dates make sense
    issue, due = to_date(form.issue_date), to_date(form.due_date)
    if form.issue_date and not issue:
        problems.append("'issue_date' is not a valid YYYY-MM-DD date.")
    if form.due_date and not due:
        problems.append("'due_date' is not a valid YYYY-MM-DD date.")
    if issue and due and due < issue:
        problems.append("The due date is before the issue date.")
    if issue and not (today - timedelta(days=3 * 365) <= issue <= today + timedelta(days=60)):
        problems.append("The issue date is implausibly far from today.")

    # 4. Every figure appears in the document
    for name, minor in (("total", total), ("subtotal", sub), ("tax", tax)):
        if minor is not None and minor != 0 and not appears(amount_variants(minor), st):
            problems.append(f"The {name} {minor / 100:.2f} does not appear in the document.")
    for i, li in enumerate(form.line_items):
        m = to_minor(li.amount)
        if m is not None and m != 0 and not appears(amount_variants(m), st):
            problems.append(f"Line {i + 1} amount {m / 100:.2f} does not appear in the document.")
    for name, d in (("issue_date", issue), ("due_date", due)):
        if d and not appears(date_variants(d), st):
            problems.append(f"The {name} {d.isoformat()} does not appear in the document.")
    if form.reference and _squash(form.reference) not in st:
        problems.append(f"The reference '{form.reference}' does not appear in the document.")
    name = form.counterparty_name.strip()
    if name and not PLACEHOLDER_RE.fullmatch(name) and fuzz.partial_ratio(name.lower(), doc_text.lower()) < 85:
        problems.append(f"The name '{name}' does not appear in the document.")

    # 5. Placeholders must be ones we created
    for f, v in form.model_dump().items():
        for ph in PLACEHOLDER_RE.findall(str(v)):
            if ph not in placeholders:
                problems.append(f"'{f}' uses the placeholder {ph}, which is not in the document.")

    return {"passed": not problems, "problems": problems}


def agree(a: DocumentForm, b: DocumentForm) -> tuple[bool, list[str]]:
    """Do two independent readings agree on the key fields?"""
    diffs = []
    if to_minor(a.total) != to_minor(b.total):
        diffs.append("total")
    if a.currency.upper() != b.currency.upper():
        diffs.append("currency")
    if (a.due_date or "") != (b.due_date or ""):
        diffs.append("due_date")
    if fuzz.token_sort_ratio(a.counterparty_name.lower(), b.counterparty_name.lower()) < 90:
        diffs.append("counterparty_name")
    return not diffs, diffs
