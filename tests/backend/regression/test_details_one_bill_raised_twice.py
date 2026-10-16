"""Bug: a bill with new bank details and a new email address was raised as two recommendations,
one for the bank details and one for the email. It is one bill, so it is one (urgent) finding."""

import uuid
from datetime import date

from tests.backend import story_books

from app import actions
from app.analytics import rules
from app.db import tenant_session
from app.pipeline import counterparties
from app.privacy.redact import value_fingerprint


def _d(kind, value):
    return {"fp": value_fingerprint(kind, value), "vault": None, "display": value[-4:]}


def test_one_bill_with_several_changes_is_one_finding(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "supplier", "Acme Supplies Ltd")
        counterparties.add_version(db, bid, cp.id, {"bank_account": _d("BANK_ACCOUNT", "41926587"),
                                                    "email": _d("EMAIL", "a@acme.example")}, "document")
        actions.propose(db, bid, "approve_document", requested_by="ai:ingestion", summary="Record bill",
                        amount_minor=100_00, reasons=["test"],
                        payload={"document_id": str(uuid.uuid4()), "counterparty_id": str(cp.id),
                                 "details": {"bank_account": _d("BANK_ACCOUNT", "55779911"),
                                             "email": _d("EMAIL", "a@acme-fake.example")}})
        found = rules.details_changed(db, date.today())
    assert [(f.kind, f.facts["changed"]) for f in found] == [("bank_details_changed", "bank account and email address")]
