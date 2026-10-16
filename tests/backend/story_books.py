"""The demo story (app/demo/story.py) loaded straight into a test business: the books as if
read from the accounting software, the bank feed as if read from the bank. Every forecast and
health figure can then be checked against answers worked out from the story itself."""

import uuid

from tests.backend.conftest import PASSWORD, people

from app.db import tenant_session
from app.demo import story
from app.models import Account, Counterparty, Record
from app.pipeline.counterparties import find_or_create
from app.seed import create_business

CATEGORY = {"acme": "cost of sales", "energy": "utilities", "software": "software subscriptions",
            "packaging": "packaging", "insurance": "insurance", "repairs": "repair and maintenance"}


def new_business(tag: str | None = None):
    tag = tag or f"story{uuid.uuid4().hex[:8]}"
    b = create_business(f"Business {tag}", people(tag), {e: PASSWORD for e, *_ in people(tag)},
                        inbox=f"bills@{tag}.test")
    return b.id, tag


def load(bid, s: story.Story | None = None) -> story.Story:
    s = s or story.build()
    with tenant_session(bid) as db:
        cps = {}
        for c in story.CUSTOMERS:
            cp, _ = find_or_create(db, bid, "customer", c.name)
            cp.payment_terms_days = c.terms
            cps[c.name] = cp
        for key, v in story.SUPPLIERS.items():
            cp, _ = find_or_create(db, bid, "supplier", v.name)
            cp.payment_terms_days = v.terms
            cps[key] = cp
        db.flush()
        for inv in s.invoices:
            net = sum(q * p for _, q, p in inv.lines)
            db.add(Record(business_id=bid, source="quickbooks", source_ref=f"story:Invoice:{inv.number}",
                          kind="invoice", direction="in", amount_minor=inv.total,
                          open_minor=0 if inv.paid_on else inv.total, currency="GBP", date=inv.issue,
                          due_date=inv.due, paid_date=inv.paid_on, status="paid" if inv.paid_on else "open",
                          counterparty_id=cps[inv.customer].id, reference=inv.number, category="sales",
                          tax_minor=inv.total - net, external={"qbo_type": "Invoice", "qbo_id": inv.number}))
        for b in s.bills:
            db.add(Record(business_id=bid, source="quickbooks", source_ref=f"story:Bill:{b.number}",
                          kind="bill", direction="out", amount_minor=b.total, open_minor=0 if b.paid_on else b.total,
                          currency="GBP", date=b.issue, due_date=b.due, paid_date=b.paid_on,
                          status="paid" if b.paid_on else "open", counterparty_id=cps[b.supplier_key].id,
                          reference=b.number, category=CATEGORY[b.supplier_key], tax_minor=b.total - b.subtotal,
                          external={"qbo_type": "Bill", "qbo_id": b.number}))
        acct = Account(business_id=bid, source="plaid", external_id=f"acct-{bid}", name="Business Current Account",
                       currency="GBP", balance_minor=story.current_balance(s))
        db.add(acct)
        db.flush()
        for i, line in enumerate(s.bank):
            db.add(Record(business_id=bid, source="plaid", source_ref=f"story:bank:{i}", kind="bank_txn",
                          direction="in" if line.amount > 0 else "out", amount_minor=abs(line.amount),
                          currency="GBP", date=line.day, status="posted", account_id=acct.id,
                          reference=line.description, description=line.description, external={}))
    return s


def story_business():
    """A new business holding the whole story, with matching already run."""
    from app.handlers import run_matching

    bid, tag = new_business()
    s = load(bid)
    with tenant_session(bid) as db:
        matched = run_matching(db, bid)
    return bid, tag, s, matched


def record(db, bid, kind: str, amount: int, day, **kw) -> Record:
    """One record, with sensible defaults for the rest."""
    direction = kw.pop("direction", "in" if kind in ("invoice", "payment_in") else "out")
    is_open = kind in ("invoice", "bill") and kw.get("status", "open") == "open"
    r = Record(business_id=bid, source=kw.pop("source", "plaid" if kind == "bank_txn" else "quickbooks"),
               source_ref=kw.pop("source_ref", uuid.uuid4().hex), kind=kind, direction=direction,
               amount_minor=amount, open_minor=kw.pop("open_minor", amount if is_open else 0), currency="GBP",
               date=day, status=kw.pop("status", "open" if kind in ("invoice", "bill") else "posted"),
               external=kw.pop("external", {}), **kw)
    db.add(r)
    db.flush()
    return r


def party(db, bid, kind: str, name: str) -> Counterparty:
    cp, _ = find_or_create(db, bid, kind, name)
    db.flush()
    return cp
