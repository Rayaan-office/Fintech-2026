"""Steps shared by the learning tests: read a bill with a scripted AI, correct it and approve it,
each in a new business so tests never see each other's corrections."""

from datetime import date, timedelta

from tests.backend import story_books
from tests.backend.conftest import acme_form

from app.db import tenant_session
from app.demo import documents as demo
from app.models import Business
from app.pipeline import ingest

ISSUE = date.today() - timedelta(days=5)


def fresh_business() -> dict:
    bid, tag = story_books.new_business()
    with tenant_session(bid) as db:
        db.get(Business, bid).auto_approve_limit_minor = 0  # every bill waits for a person
    return {"id": bid, "tag": tag}


def bill(number: str, supplier=demo.ACME, issue: date = ISSUE, terms: int = 30) -> demo.Bill:
    return demo.Bill(supplier, number, issue, issue + timedelta(days=terms),
                     [("Strong white flour 25kg", 8, 4500), ("Delivery", 1, 1500)])


def read(bid, fake_ai, b: demo.Bill, **ai) -> str:
    """The bill arrives and the AI fills in the form, with `ai` changing its answers."""
    fake_ai.push(acme_form(b, **ai))
    return str(ingest.receive(bid, demo.render(b), f"{b.number}.pdf", "upload"))


def doc(c, did) -> dict:
    return c.get(f"/api/documents/{did}").json()


def waiting(c, did, kind: str = "approve_document") -> list[dict]:
    return [a for a in doc(c, did)["actions"] if a["status"] == "pending" and a["type"] == kind]


def approve(c, did) -> dict:
    [a] = waiting(c, did)
    r = c.post(f"/api/actions/{a['id']}/approve")
    assert r.status_code == 200 and r.json()["status"] == "executed", r.text
    return doc(c, did)


def correct(c, did, **fields) -> dict:
    r = c.post(f"/api/documents/{did}/fields", json={"fields": fields})
    assert r.status_code == 200, r.text
    return r.json()


def teach(c, bid, fake_ai, numbers, ai=None, **fix):
    """Bills read with the AI's answers `ai`, each corrected with `fix` and approved."""
    for n in numbers:
        did = read(bid, fake_ai, bill(n), **(ai or {}))
        correct(c, did, **fix)
        approve(c, did)
