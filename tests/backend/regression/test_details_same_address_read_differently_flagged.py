"""Bug: the same address read slightly differently ("4, Mill Lane" and "Unit 4, Mill Lane") was
raised as a changed supplier address. Found on the demo company's two approved Acme bills."""

from datetime import date

from tests.backend import story_books

from app.analytics import rules
from app.db import tenant_session
from app.pipeline import counterparties
from app.privacy.redact import value_fingerprint


def _address(text):
    return {"address": {"fp": value_fingerprint("ADDRESS", text), "vault": None, "display": text}}


def test_same_address_read_differently_is_not_a_change(businesses):
    bid, _ = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "supplier", "Acme Supplies Ltd")
        counterparties.add_version(db, bid, cp.id, _address("4, Mill Lane, Leeds LS9 8AB"), "document")
        counterparties.add_version(db, bid, cp.id, _address("Unit 4, Mill Lane, Leeds LS9 8AB"), "document")
        assert rules.details_changed(db, date.today()) == []
        counterparties.add_version(db, bid, cp.id, _address("22 High Street, York YO1 7HU"), "document")
        assert [f.facts["changed"] for f in rules.details_changed(db, date.today())] == ["address"]
