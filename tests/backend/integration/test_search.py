"""Search on the demo story and on a small business of our own: each kind of result, its link,
amounts typed the way people type them, best matches first, and at most 20 results."""

import hashlib
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select
from tests.backend import story_books

from app.api.search import amount_minor
from app.db import tenant_session
from app.demo import emails
from app.models import Action, Counterparty, Document, Recommendation, Record
from app.pipeline.counterparties import normalize

TODAY = date.today()


def add_document(db, bid, filename: str, cp: Counterparty | None = None, **kw) -> Document:
    d = Document(business_id=bid, source="email", status=kw.pop("status", "approved"), stage="done",
                 filename=filename, mime="application/pdf", size_bytes=100,
                 sha256=hashlib.sha256(uuid.uuid4().bytes).hexdigest(), object_key=f"test/{uuid.uuid4()}",
                 doc_type=kw.pop("doc_type", "bill"), counterparty_id=cp.id if cp else None, **kw)
    db.add(d)
    db.flush()
    return d


def add_recommendation(db, bid, title: str, cp: Counterparty | None = None, status="new") -> Recommendation:
    r = Recommendation(business_id=bid, kind="price_rise", fingerprint=uuid.uuid4().hex, severity="watch",
                       counterparty_id=cp.id if cp else None, facts={}, title=title, body="", status=status)
    db.add(r)
    db.flush()
    return r


def add_action(db, bid, summary: str, status="pending") -> Action:
    a = Action(business_id=bid, type="approve_document", level=2, status=status, summary=summary, payload={},
               requested_by="ai:test")
    db.add(a)
    db.flush()
    return a


@pytest.fixture(scope="module")
def story(businesses):
    bid, tag = story_books.new_business()
    s = story_books.load(bid)
    emailed = emails.emailed_bills(s)["acme"]
    with tenant_session(bid) as db:
        cps = {c.display_name: c for c in db.execute(select(Counterparty)).scalars()}
        acme, ovens = cps["Acme Supplies Ltd"], cps["Oven Doctors Ltd"]
        # Acme's latest bill arrived as a document
        doc = add_document(db, bid, f"{emailed.number}.pdf", acme)
        bill = db.execute(select(Record).where(Record.reference == emailed.number)).scalar_one()
        bill.document_id, doc.record_id = doc.id, bill.id
        rec = add_recommendation(db, bid, "Oven Doctors Ltd raised the price of a call-out", ovens)
        add_recommendation(db, bid, "Oven Doctors Ltd old news", ovens, status="dismissed")
        act = add_action(db, bid, "Record bill: £1,860.00 from Oven Doctors Ltd")
        add_action(db, bid, "Record bill: £10.00 from Oven Doctors Ltd, already done", status="executed")
        ids = {"doc": doc.id, "bill": bill.id, "rec": rec.id, "action": act.id, "acme": acme.id, "ovens": ovens.id}
    return {"id": bid, "tag": tag, "story": s, "emailed": emailed, **ids}


def _party(db, bid, kind: str, name: str) -> Counterparty:
    """Added as is: find_or_create would treat "Zed Customer A" and "Zed Customer B" as one."""
    cp = Counterparty(business_id=bid, kind=kind, display_name=name, normalized_name=normalize(name))
    db.add(cp)
    db.flush()
    return cp


@pytest.fixture(scope="module")
def small(businesses):
    """A business with names and amounts chosen for the ranking, amount and cap checks."""
    bid, tag = story_books.new_business()
    with tenant_session(bid) as db:
        zed = story_books.party(db, bid, "supplier", "Zed")
        for i in range(10):
            c = _party(db, bid, "customer", f"Zed Customer {chr(65 + i)}")
            s = _party(db, bid, "supplier", f"Zed Supplier {chr(65 + i)}")
            story_books.record(db, bid, "invoice", 1000 + i, TODAY, reference=f"ZED-{i}", counterparty_id=c.id)
            story_books.record(db, bid, "bill", 2000 + i, TODAY, reference=f"BZED-{i}", counterparty_id=s.id)
        tea = story_books.party(db, bid, "supplier", "Tea Leaves Ltd")
        story_books.record(db, bid, "bill", 30000, TODAY, reference="TL-1", counterparty_id=tea.id)
        story_books.record(db, bid, "bill", 180000, TODAY - timedelta(days=3), reference="TL-2",
                           counterparty_id=tea.id, status="paid", paid_date=TODAY)
        story_books.record(db, bid, "bill", 180000, TODAY, reference="TL-3", counterparty_id=tea.id, status="void")
        story_books.record(db, bid, "bank_txn", 30000, TODAY, reference="TEA LEAVES 300.00")
        ids = {"zed": zed.id, "tea": tea.id}
    return {"id": bid, "tag": tag, **ids}


def _search(c, q):
    r = c.post("/api/search", json={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def _owner(sign_in, biz):
    return sign_in(f"owner@{biz['tag']}.test")


# ── Each kind ─────────────────────────────────────────────────────────────


def test_customers_and_suppliers_by_name(story, sign_in):
    c = _owner(sign_in, story)
    res = _search(c, "bright")
    kinds = [(r["kind"], r["label"]) for r in res[:2]]
    assert kinds == [("customer", "Bright Cafe"), ("supplier", "BrightSpark Energy Ltd")]
    # A customer with nothing open to look at goes to who owes you; a supplier with nothing to its own page
    assert res[0]["href"] == "/health?view=owed" and res[1]["href"] == "/health?view=suppliers"


def test_a_supplier_goes_to_its_open_recommendation_or_newest_document(story, sign_in):
    c = _owner(sign_in, story)
    ovens = next(r for r in _search(c, "oven doctors") if r["kind"] == "supplier")
    assert ovens["href"] == f"/recommendations?open={story['rec']}"
    acme = next(r for r in _search(c, "acme") if r["kind"] == "supplier")
    assert acme == {"id": str(story["acme"]), "kind": "supplier", "label": "Acme Supplies Ltd",
                    "href": f"/documents?open={story['doc']}"}


def test_typo_still_finds_the_supplier(story, sign_in):
    res = _search(_owner(sign_in, story), "acme suplies")
    assert [r["label"] for r in res if r["kind"] == "supplier"] == ["Acme Supplies Ltd"]


def test_invoices_by_reference(story, sign_in):
    inv = next(i for i in story["story"].invoices if not i.paid_on)
    res = _search(_owner(sign_in, story), inv.number)
    first = res[0]
    assert first["kind"] == "invoice"
    assert first["label"] == f"Invoice {inv.number} · {inv.customer} · £{inv.total / 100:,.2f}"
    assert first["href"] == "/health?view=owed"


def test_a_bill_with_its_document_opens_the_document(story, sign_in):
    b = story["emailed"]
    res = _search(_owner(sign_in, story), b.number)
    bill = next(r for r in res if r["kind"] == "bill")
    assert bill == {"id": str(story["bill"]), "kind": "bill",
                    "label": f"Bill {b.number} · Acme Supplies Ltd · £{b.total / 100:,.2f}",
                    "href": f"/documents?open={story['doc']}"}


def test_an_unpaid_bill_without_a_document_goes_to_the_forecast(story, sign_in):
    b = next(b for b in story["story"].bills if not b.paid_on and b.number != story["emailed"].number)
    bill = next(r for r in _search(_owner(sign_in, story), b.number) if r["kind"] == "bill")
    assert bill["href"] == "/cash-flow"


def test_documents_by_filename_and_supplier(story, sign_in):
    c = _owner(sign_in, story)
    want = {"id": str(story["doc"]), "kind": "document", "label": f"{story['emailed'].number}.pdf · Acme Supplies Ltd",
            "href": f"/documents?open={story['doc']}"}
    assert want in _search(c, f"{story['emailed'].number}.pdf")
    assert want in _search(c, "acme supplies")


def test_open_recommendations_by_title(story, sign_in):
    res = [r for r in _search(_owner(sign_in, story), "oven doctors") if r["kind"] == "recommendation"]
    assert res == [{"id": str(story["rec"]), "kind": "recommendation",
                    "label": "Oven Doctors Ltd raised the price of a call-out",
                    "href": f"/recommendations?open={story['rec']}"}]  # the dismissed one is left out


def test_pending_approvals_by_summary(story, sign_in):
    res = [r for r in _search(_owner(sign_in, story), "oven doctors") if r["kind"] == "approval"]
    assert res == [{"id": str(story["action"]), "kind": "approval",
                    "label": "Record bill: £1,860.00 from Oven Doctors Ltd", "href": f"/inbox?action={story['action']}"}]


def test_every_role_that_sees_everything_can_search(story, sign_in):
    for who in ("owner", "finance", "books"):
        assert _search(sign_in(f"{who}@{story['tag']}.test"), "acme")


# ── Amounts ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("q, minor", [("300", 30000), ("£300", 30000), ("300.00", 30000), ("1,800.00", 180000),
                                      ("£1,800", 180000), ("12.5", 1250), ("0.99", 99)])
def test_amounts_as_people_type_them(q, minor):
    assert amount_minor(q) == minor


@pytest.mark.parametrize("q", ["30o", "1,80.00", "1.234", "£", "-300", "AS-1005"])
def test_not_amounts(q):
    assert amount_minor(q) is None


@pytest.mark.parametrize("q", ["300", "£300", "300.00"])
def test_search_by_amount(small, sign_in, q):
    res = _search(_owner(sign_in, small), q)
    assert [r["label"] for r in res] == ["Bill TL-1 · Tea Leaves Ltd · £300.00"]  # not the bank line


def test_search_by_amount_with_thousands(small, sign_in):
    res = _search(_owner(sign_in, small), "1,800.00")
    assert [r["label"] for r in res] == ["Bill TL-2 · Tea Leaves Ltd · £1,800.00 · paid"]  # the voided one is left out


# ── Ranking and limits ────────────────────────────────────────────────────


def test_best_first_and_at_most_twenty(small, sign_in):
    res = _search(_owner(sign_in, small), "zed")
    assert len(res) == 20
    assert res[0] == {"id": str(small["zed"]), "kind": "supplier", "label": "Zed", "href": "/health?view=suppliers"}
    # Then everything that starts with it, grouped by kind; bills whose reference only contains it are cut
    kinds = [r["kind"] for r in res[1:]]
    assert kinds == sorted(kinds, key=["customer", "supplier", "invoice"].index)
    assert set(kinds) == {"customer", "supplier", "invoice"}


def test_prefix_before_contains(small, sign_in):
    res = _search(_owner(sign_in, small), "leaves")
    assert res[0]["label"] == "Tea Leaves Ltd"  # a word starting with it
    res = _search(_owner(sign_in, small), "tea")
    assert res[0]["label"] == "Tea Leaves Ltd"


def test_short_search_returns_nothing_and_long_is_refused(small, sign_in):
    c = _owner(sign_in, small)
    assert _search(c, "z") == []
    assert _search(c, "   z   ") == []
    assert _search(c, "ze")
    assert c.post("/api/search", json={"q": "z" * 101}).status_code == 422
    assert c.post("/api/search", json={}).status_code == 422
    assert _search(c, "  " + "z" * 98 + "  ") == []  # trimmed to 98: allowed, no match


def test_rate_limited_per_person(small, sign_in):
    c = _owner(sign_in, small)
    for _ in range(60):
        assert c.post("/api/search", json={"q": "zz"}).status_code == 200
    assert c.post("/api/search", json={"q": "zz"}).status_code == 429
    assert sign_in(f"books@{small['tag']}.test").post("/api/search", json={"q": "zz"}).status_code == 200
