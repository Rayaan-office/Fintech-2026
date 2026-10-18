"""Learning from decisions, end to end: corrections on approved bills are remembered per supplier and
filled in next time (with Undo), recommendations are ranked by what was acted on, and the owner can
reset it all."""

from datetime import timedelta

import pytest
from sqlalchemy import select
from tests.backend.learning_steps import approve, bill, correct, doc, fresh_business, read, teach

import app.handlers  # noqa: F401  (registers approval handlers)
from app.copilot import learning
from app.db import tenant_session
from app.demo import documents as demo
from app.models import (
    Action,
    AuditEntry,
    Correction,
    Counterparty,
    Document,
    LearningStat,
    Recommendation,
    Record,
)


@pytest.fixture
def biz(businesses):
    return fresh_business()


# ── Correction memory ──────────────────────────────────────────────────────


def test_a_category_is_learned_after_two_corrections_not_one(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["L-1"], category_hint="packaging")
    once = doc(c, read(biz["id"], fake_ai, bill("L-2")))
    assert once["fields"]["category_hint"] == "stock" and once["learned"] == {}  # one correction is not enough
    correct(c, once["id"], category_hint="packaging")
    approve(c, once["id"])

    third = doc(c, read(biz["id"], fake_ai, bill("L-3")))
    assert third["fields"]["category_hint"] == "packaging"
    assert third["learned"]["category_hint"] == {"value": "packaging", "ai_value": "stock", "corrections": 2,
                                                 "learned_as": "category_hint", "undone": False}
    assert "1 value(s) filled from your past corrections" in third["timeline"][-1]["note"]
    assert "packaging" not in fake_ai.calls[-1]["sent"].lower()  # learning stays in our database


def test_a_learned_value_is_used_for_the_record(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["R-1", "R-2"], category_hint="packaging")
    did = read(biz["id"], fake_ai, bill("R-3"))
    approve(c, did)
    with tenant_session(biz["id"]) as db:
        rec = db.execute(select(Record).where(Record.reference == "R-3")).scalar_one()
        assert rec.category == "packaging"


def test_undo_puts_the_ai_answer_back_and_a_disagreement_stops_learning(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["U-1", "U-2"], category_hint="packaging")
    filled = doc(c, read(biz["id"], fake_ai, bill("U-3")))
    assert filled["fields"]["category_hint"] == "packaging"
    undone = correct(c, filled["id"], category_hint=filled["learned"]["category_hint"]["ai_value"])  # Undo
    assert undone["fields"]["category_hint"] == "stock" and undone["learned"]["category_hint"]["undone"] is True
    approve(c, filled["id"])
    after = doc(c, read(biz["id"], fake_ai, bill("U-4")))
    assert after["fields"]["category_hint"] == "stock" and after["learned"] == {}


def test_a_later_bill_that_ended_up_different_also_stops_learning(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["D-1", "D-2"], category_hint="packaging")
    teach(c, biz["id"], fake_ai, ["D-3"], category_hint="cleaning")  # corrected again, to something else
    after = doc(c, read(biz["id"], fake_ai, bill("D-4")))
    assert after["learned"] == {} and after["fields"]["category_hint"] == "stock"


def test_payment_terms_are_learned_and_still_need_a_check(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    for n in ("T-1", "T-2"):
        b = bill(n)
        did = read(biz["id"], fake_ai, b, due_date=b.issue.isoformat())  # the AI keeps reading "due on receipt"
        correct(c, did, due_date=b.due.isoformat())
        approve(c, did)
    b = bill("T-3")
    third = doc(c, read(biz["id"], fake_ai, b, due_date=b.issue.isoformat()))
    assert third["fields"]["due_date"] == (b.issue + timedelta(days=30)).isoformat()
    assert third["learned"]["due_date"]["learned_as"] == "payment_terms"
    assert third["status"] == "awaiting_approval"
    assert any("please check: payment terms" in r for r in third["review_reasons"])


def test_a_supplier_name_the_ai_keeps_misreading_is_learned(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    for n in ("N-1", "N-2"):
        did = read(biz["id"], fake_ai, bill(n, supplier=demo.PACKAGING))
        correct(c, did, counterparty_name="PD Wholesale Ltd")
        approve(c, did)
    third = doc(c, read(biz["id"], fake_ai, bill("N-3", supplier=demo.PACKAGING)))
    assert third["counterparty"] == "PD Wholesale Ltd"
    assert third["learned"]["counterparty_name"]["ai_value"] == "Packaging Direct Ltd"
    assert any("supplier name" in r for r in third["review_reasons"])  # a learned name is never recorded on its own


def test_corrections_on_documents_still_waiting_are_not_learned(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    for n in ("W-1", "W-2"):
        correct(c, read(biz["id"], fake_ai, bill(n)), category_hint="packaging")  # never approved
    assert doc(c, read(biz["id"], fake_ai, bill("W-3")))["learned"] == {}


def test_a_rejected_bill_teaches_nothing(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["J-1"], category_hint="packaging")
    did = read(biz["id"], fake_ai, bill("J-2"))
    correct(c, did, category_hint="packaging")
    a = next(a for a in doc(c, did)["actions"] if a["status"] == "pending")
    assert c.post(f"/api/actions/{a['id']}/reject").status_code == 200
    assert doc(c, read(biz["id"], fake_ai, bill("J-3")))["learned"] == {}


# ── What we've learned, and reset ──────────────────────────────────────────


def test_the_learning_page_explains_what_was_learned_with_counts(biz, fake_ai, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["P-1", "P-2"], category_hint="packaging")
    approve(c, read(biz["id"], fake_ai, bill("P-3")))
    out = c.get("/api/learning").json()
    [acme] = out["suppliers"]
    assert acme["name"] == "Acme Supplies Ltd"
    assert acme["items"] == [{"field": "category_hint", "label": "What it's for", "value": "packaging",
                              "value_label": "packaging", "corrections": 2,
                              "sentence": "We fill in what it's for as “packaging”: you corrected it on 2 documents."}]
    n = out["numbers"]
    assert (n["fields_filled"], n["fields_kept"], n["fields_undone"], n["documents_helped"]) == (1, 1, 0, 1)
    assert n["seconds_per_field"] == 30 and n["minutes_saved"] == 0.5
    assert out["can_reset"] is False and "bank details" in out["never_learned"]


def test_only_the_owner_can_reset_and_each_reset_is_logged(biz, fake_ai, sign_in):
    books = sign_in(f"books@{biz['tag']}.test")
    teach(books, biz["id"], fake_ai, ["X-1", "X-2"], category_hint="packaging")
    with tenant_session(biz["id"]) as db:
        acme = db.execute(select(Document.counterparty_id).where(Document.status == "approved")).scalars().first()
    body = {"scope": "supplier", "counterparty_id": str(acme)}
    assert books.post("/api/learning/reset", json=body).status_code == 403
    assert sign_in(f"finance@{biz['tag']}.test").post("/api/learning/reset", json=body).status_code == 403

    owner = sign_in(f"owner@{biz['tag']}.test")
    r = owner.post("/api/learning/reset", json=body)
    assert r.status_code == 200 and r.json()["corrections_forgotten"] == 2 and r.json()["suppliers"] == []
    assert doc(books, read(biz["id"], fake_ai, bill("X-3")))["learned"] == {}
    with tenant_session(biz["id"]) as db:
        entry = db.execute(select(AuditEntry).where(AuditEntry.event == "learning_reset")).scalar_one()
        assert entry.details["scope"] == "supplier" and entry.actor.startswith("user:")
        # Corrections are kept as history, just no longer learned from
        assert db.execute(select(Correction).where(Correction.forgotten_at.is_not(None))).scalars().all()


def test_resetting_one_field_keeps_the_others(biz, fake_ai, sign_in):
    books = sign_in(f"books@{biz['tag']}.test")
    teach(books, biz["id"], fake_ai, ["F-1", "F-2"], category_hint="packaging", currency="EUR")
    with tenant_session(biz["id"]) as db:
        acme = db.execute(select(Document.counterparty_id).where(Document.status == "approved")).scalars().first()
        assert set(learning.learned_fields(db, acme)) == {"category_hint", "currency"}
    owner = sign_in(f"owner@{biz['tag']}.test")
    r = owner.post("/api/learning/reset", json={"scope": "field", "counterparty_id": str(acme), "field": "currency"})
    assert [i["field"] for i in r.json()["suppliers"][0]["items"]] == ["category_hint"]


# ── The ranking that learns ────────────────────────────────────────────────


def _rec(bid, kind, severity="watch", money=10_000, fp=None, step=None):
    with tenant_session(bid) as db:
        r = Recommendation(business_id=bid, kind=kind, fingerprint=fp or f"{kind}:{money}", severity=severity,
                           money_at_stake_minor=money, score=money, facts={}, title=f"{kind} {money}", body="x",
                           next_step=step or {"label": "Review this cost", "action": None, "href": "/health"})
        db.add(r)
        db.flush()
        return str(r.id)


def _stat(bid, kind):
    with tenant_session(bid) as db:
        s = db.execute(select(LearningStat).where(LearningStat.arm == kind)).scalar_one_or_none()
        return (s.wins, s.losses) if s else (0, 0)


def test_dismissing_and_following_are_counted_once_each(biz, sign_in):
    c = sign_in(f"books@{biz['tag']}.test")
    a, b = _rec(biz["id"], "spending_creep", money=500), _rec(biz["id"], "price_rise", money=400)
    assert c.post(f"/api/recommendations/{a}/dismiss", json={"mute": False}).status_code == 200
    assert _stat(biz["id"], "spending_creep") == (0, 1)
    c.post(f"/api/recommendations/{b}/followed")
    c.post(f"/api/recommendations/{b}/followed")  # clicking twice counts once
    assert _stat(biz["id"], "price_rise") == (1, 0)
    # Both were first in the list when decided
    assert _stat(biz["id"], learning.TOP_ARM) == (1, 1)
    n = c.get("/api/learning").json()["numbers"]
    assert (n["top_decisions"], n["top_acted_on"], n["top_acted_share"]) == (2, 1, 0.5)


def test_a_drafted_email_that_is_rejected_counts_as_turned_down(biz, sign_in, monkeypatch):
    from app.copilot import insights, wording
    from app.pipeline.counterparties import find_or_create

    with tenant_session(biz["id"]) as db:
        cid = find_or_create(db, biz["id"], "supplier", "Acme Supplies Ltd")[0].id
    rid = _rec(biz["id"], "price_rise", step={"label": "Draft an email", "action": "email_supplier"})

    def draft(db, r):
        return insights.Draft(counterparty=db.get(Counterparty, cid), to="a•••@acme.example", subject="Your prices",
                              body="Hello, could you explain the new prices?", contact_as_of=None,
                              written=wording.Written(title="", body="", ai_written=False))

    monkeypatch.setattr(insights, "draft_for_recommendation", draft)
    c = sign_in(f"books@{biz['tag']}.test")
    act = c.post(f"/api/recommendations/{rid}/next-step").json()["action"]
    assert _stat(biz["id"], "price_rise") == (1, 0)
    assert c.post(f"/api/actions/{act['id']}/reject").status_code == 200
    assert _stat(biz["id"], "price_rise") == (0, 1)  # replaced, not counted twice


def test_a_kind_that_is_rarely_useful_is_folded_and_ranked_lower(biz, sign_in):
    bid = biz["id"]
    creep, price = _rec(bid, "spending_creep", money=900), _rec(bid, "price_rise", money=800)
    urgent = _rec(bid, "bank_details_changed", severity="urgent", money=0)
    with tenant_session(bid) as db:
        db.add_all([LearningStat(business_id=bid, arm="spending_creep", wins=0, losses=6),
                    LearningStat(business_id=bid, arm="price_rise", wins=6, losses=0),
                    LearningStat(business_id=bid, arm="bank_details_changed", wins=0, losses=50)])
    items = sign_in(f"books@{biz['tag']}.test").get("/api/recommendations").json()["items"]
    assert [i["id"] for i in items] == [urgent, price, creep]
    assert {i["id"]: i["less_useful"] for i in items} == {urgent: False, price: False, creep: True}


def test_resetting_a_kind_clears_its_ranking(biz, sign_in):
    bid = biz["id"]
    with tenant_session(bid) as db:
        db.add_all([LearningStat(business_id=bid, arm="spending_creep", wins=0, losses=6),
                    LearningStat(business_id=bid, arm="price_rise", wins=2, losses=1)])
    owner = sign_in(f"owner@{biz['tag']}.test")
    before = owner.get("/api/learning").json()["recommendations"]
    assert {k["kind"]: k["less_useful"] for k in before} == {"price_rise": False, "spending_creep": True}
    r = owner.post("/api/learning/reset", json={"scope": "kind", "kind": "spending_creep"})
    assert [k["kind"] for k in r.json()["recommendations"]] == ["price_rise"]
    r = owner.post("/api/learning/reset", json={"scope": "all"})
    assert r.json()["recommendations"] == [] and r.json()["rankings_cleared"] == 1


def test_waiting_actions_still_need_their_approval(biz, fake_ai, sign_in):
    """Learning never approves anything: a learned bill still waits for a person."""
    c = sign_in(f"books@{biz['tag']}.test")
    teach(c, biz["id"], fake_ai, ["A-1", "A-2"], category_hint="packaging")
    did = read(biz["id"], fake_ai, bill("A-3"))
    with tenant_session(biz["id"]) as db:
        assert db.execute(select(Action).where(Action.payload["document_id"].astext == did,
                                               Action.status == "pending")).scalar_one()
