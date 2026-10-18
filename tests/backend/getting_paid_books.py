"""A small business for the getting-paid tests: a customer abroad whose invoice INV-9001 was paid
by international transfer and arrived £18.60 short, and whose INV-9002 is 10 days overdue."""

from datetime import date, timedelta
from types import SimpleNamespace

from tests.backend import story_books

from app.db import tenant_session
from app.handlers import run_matching
from app.models import Business
from app.pipeline import counterparties
from app.privacy.redact import mask, store_value, value_fingerprint

TODAY = date.today()
SHORT = 18_60  # a fixed charge taken on the way: more than 3% + 50p of £400


def email_on_record(db, bid, cp_id, address: str):
    counterparties.add_version(db, bid, cp_id, {"email": {
        "fp": value_fingerprint("EMAIL", address), "vault": store_value(bid, "EMAIL", address),
        "display": mask("EMAIL", address)}}, "test")


def match(db, bid) -> dict:
    """Matching as it runs when new data arrives (small confident matches are automatic only while AI is on)."""
    biz = db.get(Business, bid)
    paused, biz.ai_paused = biz.ai_paused, False
    out = run_matching(db, bid)
    biz.ai_paused = paused
    return out


def short_paid_business(name: str = "Rotterdam Bakery BV", pause_ai: bool = True) -> SimpleNamespace:
    bid, tag = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "customer", name)
        email_on_record(db, bid, cp.id, "accounts@rotterdambakery.example")
        paid = story_books.record(db, bid, "invoice", 400_00, TODAY - timedelta(days=60), counterparty_id=cp.id,
                                  due_date=TODAY - timedelta(days=30), reference="INV-9001")
        story_books.record(db, bid, "bank_txn", 400_00 - SHORT, TODAY - timedelta(days=28), direction="in",
                           description=f"INTL PAYMENT {name.upper()} SWIFT REF INV-9001")
        late = story_books.record(db, bid, "invoice", 360_00, TODAY - timedelta(days=40), counterparty_id=cp.id,
                                  due_date=TODAY - timedelta(days=10), reference="INV-9002")
        ids = SimpleNamespace(cp=cp.id, paid=paid.id, late=late.id)
    with tenant_session(bid) as db:
        matched = match(db, bid)
        db.get(Business, bid).ai_paused = pause_ai  # our templates, so the tests need no AI
    return SimpleNamespace(id=bid, tag=tag, ids=ids, matched=matched)
