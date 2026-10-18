"""Learning stays safe: bank details are never learned, what one business teaches never reaches
another, only the owner resets it, and correcting a supplier never drops a bank-detail check."""

import uuid

import pytest
from sqlalchemy import select
from tests.backend.learning_steps import approve, bill, correct, doc, fresh_business, read, teach, waiting

import app.handlers  # noqa: F401  (registers approval handlers)
from app.copilot import learning
from app.db import tenant_session
from app.demo import documents as demo
from app.models import Correction, Document, LearningStat, Recommendation


@pytest.fixture
def biz(businesses):
    return fresh_business()


def test_bank_details_contacts_and_amounts_are_never_learned(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["S-1", "S-2"], category_hint="packaging")
    with tenant_session(biz["id"]) as db:
        docs = db.execute(select(Document).where(Document.status == "approved")).scalars().all()
        cp = docs[0].counterparty_id
        # Even if corrections to these fields were somehow stored, nothing is learned from them
        for d in docs:
            for field, ai, human in (("payment_bank_account", "[BANK_ACCOUNT_1]", "99887766"),
                                     ("payment_sort_code", "[SORT_CODE_1]", "11-22-33"),
                                     ("contact_email", "[EMAIL_1]", "pay@elsewhere.example"),
                                     ("total", "504.00", "1.00")):
                db.add(Correction(business_id=biz["id"], document_id=d.id, field=field, ai_value=ai,
                                  human_value=human, user_id=uuid.uuid4(), counterparty_id=cp))
                d.fields = {**d.fields, field: human}
        db.flush()
        assert set(learning.learned_fields(db, cp)) == {"category_hint"}
    third = doc(c, read(biz["id"], fake_ai, bill("S-3")))
    assert set(third["learned"]) == {"category_hint"}
    assert third["fields"]["payment_bank_account"] == "••••6587"  # still read from this bill, masked


def test_bank_and_contact_fields_cannot_be_corrected_through_the_api(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    did = read(biz["id"], fake_ai, bill("S-4"))
    for field in ("payment_bank_account", "payment_sort_code", "contact_email", "contact_phone", "address"):
        r = c.post(f"/api/documents/{did}/fields", json={"fields": {field: "12345678"}})
        assert r.status_code == 422


def test_what_one_business_learns_never_reaches_another(businesses, fake_ai, sign_in):
    a, b = fresh_business(), fresh_business()
    teach(sign_in(f"books@{a['tag']}.test"), a["id"], fake_ai, ["I-1", "I-2"], category_hint="packaging")
    other = sign_in(f"books@{b['tag']}.test")
    same_supplier = doc(other, read(b["id"], fake_ai, bill("I-3")))
    assert same_supplier["learned"] == {} and same_supplier["fields"]["category_hint"] == "stock"
    assert other.get("/api/learning").json()["suppliers"] == []
    with tenant_session(a["id"]) as db:
        acme = db.execute(select(Document.counterparty_id).where(Document.status == "approved")).scalars().first()
        rec = Recommendation(business_id=a["id"], kind="price_rise", fingerprint="iso-learn", severity="watch",
                             facts={}, title="x", body="x", next_step={"label": "Look", "action": None, "href": "/health"})
        db.add(rec)
        db.flush()
        rid = rec.id
    owner_b = sign_in(f"owner@{b['tag']}.test")
    assert owner_b.post("/api/learning/reset", json={"scope": "supplier", "counterparty_id": str(acme)}).status_code == 404
    assert owner_b.post(f"/api/recommendations/{rid}/followed").status_code == 404
    with tenant_session(a["id"]) as db:
        assert not db.execute(select(LearningStat)).scalars().all()  # nothing was counted
        assert all(c.forgotten_at is None for c in db.execute(select(Correction)).scalars())


def test_employees_cannot_see_or_reset_what_was_learned(biz, sign_in):
    staff = sign_in(f"staff@{biz['tag']}.test")
    assert staff.get("/api/learning").status_code == 403
    assert staff.post("/api/learning/reset", json={"scope": "all"}).status_code == 403


def test_reset_refuses_unknown_kinds_and_fields(biz, sign_in):
    owner = sign_in(f"owner@{biz['tag']}.test")
    assert owner.post("/api/learning/reset", json={"scope": "kind", "kind": "DROP TABLE"}).status_code == 422
    assert owner.post("/api/learning/reset", json={"scope": "field", "counterparty_id": str(uuid.uuid4()),
                                                   "field": "payment_bank_account"}).status_code == 422
    assert owner.post("/api/learning/reset", json={"scope": "everything"}).status_code == 422


def test_correcting_the_supplier_moves_the_bank_detail_check_and_keeps_two_people(biz, fake_ai, sign_in):
    books = sign_in(f"books@{biz['tag']}.test")
    first = read(biz["id"], fake_ai, bill("B-1"))
    approve(books, first)
    fraud = demo.acme_fraud_bill()
    did = read(biz["id"], fake_ai, fraud)
    [old_bank] = waiting(books, did, "change_supplier_bank")

    after = correct(books, did, counterparty_name="Packaging Direct Ltd")
    statuses = {a["id"]: a["status"] for a in after["actions"]}
    assert statuses[old_bank["id"]] == "cancelled"
    [new_bank] = waiting(books, did, "change_supplier_bank")
    assert "Packaging Direct Ltd" in new_bank["summary"] and new_bank["level"] == 4
    [bill_action] = waiting(books, did)
    assert books.post(f"/api/actions/{new_bank['id']}/approve").status_code == 403  # still two senior people
    assert books.post(f"/api/actions/{bill_action['id']}/approve").status_code == 409  # still blocked
