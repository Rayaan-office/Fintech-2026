"""Search stays inside one business, is closed to employees, treats % and _ as plain characters,
never writes what was searched for anywhere, and never shows bank details, emails or phone numbers."""

import logging
from datetime import date

import pytest
from sqlalchemy import select, text
from tests.backend import story_books
from tests.backend.integration.test_search import add_document

from app.db import tenant_session
from app.models import AuditEntry


@pytest.fixture(scope="module")
def two(businesses):
    """Two businesses with the same supplier name, so a leak would show."""
    out = {}
    for key in ("one", "two"):
        bid, tag = story_books.new_business()
        with tenant_session(bid) as db:
            cp = story_books.party(db, bid, "supplier", "Shared Name Widgets Ltd")
            r = story_books.record(db, bid, "bill", 4321, date.today(), reference=f"SNW-{key}", counterparty_id=cp.id)
            d = add_document(db, bid, f"widgets-{key}.pdf", cp)
            out[key] = {"id": bid, "tag": tag, "ids": {str(cp.id), str(r.id), str(d.id)}}
        with tenant_session(bid) as db:
            story_books.party(db, bid, "supplier", "100% Organic Ltd")
            story_books.party(db, bid, "supplier", "Under_Score Ltd")
            add_document(db, bid, "receipt jo.bloggs@example.com 07700 900123 sort 12-34-56.pdf")
    return out


def _search(c, q):
    r = c.post("/api/search", json={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_only_the_callers_business(two, sign_in):
    for me, other in (("one", "two"), ("two", "one")):
        c = sign_in(f"owner@{two[me]['tag']}.test")
        for q in ("shared name", "widgets", "SNW-", "43.21", "£43.21"):
            ids = {r["id"] for r in _search(c, q)}
            assert ids and ids <= two[me]["ids"], q
            assert not ids & two[other]["ids"]
        assert _search(c, f"SNW-{other}") == []


def test_employees_cannot_search(two, sign_in):
    c = sign_in(f"staff@{two['one']['tag']}.test")
    r = c.post("/api/search", json={"q": "widgets"})
    assert r.status_code == 403


def test_signed_out_cannot_search(client):
    assert client.post("/api/search", json={"q": "widgets"}).status_code == 401


def test_percent_and_underscore_are_plain_characters(two, sign_in):
    c = sign_in(f"owner@{two['one']['tag']}.test")
    # As wildcards these would match "Shared Name Widgets" (e…s) and "Under_Score" / "Name W"
    assert _search(c, "e%s") == []
    assert _search(c, "%%") == []
    assert _search(c, "__") == []
    assert [r["label"] for r in _search(c, "0%")] == ["100% Organic Ltd"]
    assert [r["label"] for r in _search(c, "r_s")] == ["Under_Score Ltd"]
    assert _search(c, "e_w") == []  # "Name Widgets" has "e W", which _ would have matched
    assert _search(c, "\\") == [] and _search(c, "a\\") == []


def test_what_was_searched_is_never_written_down(two, sign_in, caplog):
    secret = "Zebedee Quux-Fernsby"
    c = sign_in(f"owner@{two['one']['tag']}.test")
    with tenant_session(two["one"]["id"]) as db:
        before = db.execute(select(AuditEntry.seq).order_by(AuditEntry.seq.desc()).limit(1)).scalar() or 0
    with caplog.at_level(logging.DEBUG):
        assert _search(c, secret) == []
        assert _search(c, "widgets")
    assert secret.lower() not in caplog.text.lower() and "zebedee" not in caplog.text.lower()
    with tenant_session(two["one"]["id"]) as db:
        rows = db.execute(text("SELECT coalesce(subject, '') || ' ' || details::text FROM audit_log WHERE seq > :s"),
                          {"s": before}).scalars().all()
        everything = db.execute(text("SELECT string_agg(coalesce(subject, '') || details::text, ' ') FROM audit_log"))\
            .scalar() or ""
    assert not any("zebedee" in r.lower() for r in rows)
    assert "zebedee" not in everything.lower()


def test_search_is_read_only(two, sign_in):
    """Searching changes nothing, so it leaves no trace in the activity log at all."""
    c = sign_in(f"owner@{two['one']['tag']}.test")
    with tenant_session(two["one"]["id"]) as db:
        n = db.execute(text("SELECT count(*) FROM audit_log")).scalar()
    _search(c, "widgets")
    with tenant_session(two["one"]["id"]) as db:
        assert db.execute(text("SELECT count(*) FROM audit_log")).scalar() == n


def test_labels_leave_out_bank_details_emails_and_phones(two, sign_in):
    c = sign_in(f"owner@{two['one']['tag']}.test")
    res = _search(c, "receipt")
    assert len(res) == 1
    label = res[0]["label"]
    assert label.startswith("receipt ") and label.endswith(".pdf")
    for leak in ("@", "example.com", "07700", "900123", "12-34-56"):
        assert leak not in label


def test_links_carry_ids_only(two, sign_in):
    c = sign_in(f"owner@{two['one']['tag']}.test")
    for r in _search(c, "widgets") + _search(c, "shared name"):
        assert "widget" not in r["href"].lower() and "shared" not in r["href"].lower()
        assert r["href"].startswith("/")


# ── Page pictures: the same access as the original ────────────────────────


def test_page_pictures_have_the_same_access_as_the_original(two, sign_in):
    from tests.backend.integration.test_document_pages import _doc, _pdf, _user_id

    me, other = two["one"]["tag"], two["two"]["tag"]
    mine = _doc(two["one"]["id"], _pdf(1), pages=1, submitted_by=_user_id(f"staff@{me}.test"))
    theirs = _doc(two["one"]["id"], _pdf(1), pages=1)
    for who in (f"owner@{me}", f"finance@{me}", f"books@{me}", f"staff@{me}", f"owner@{other}", f"staff@{other}"):
        c = sign_in(f"{who}.test")
        for did in (mine, theirs):
            original = c.get(f"/api/documents/{did}/original").status_code
            page = c.get(f"/api/documents/{did}/pages/0").status_code
            assert original == page, (who, did)
            assert page in (200, 404)
    # Spelled out: employees see only what they sent in, and another business sees nothing
    staff_c = sign_in(f"staff@{me}.test")
    assert staff_c.get(f"/api/documents/{mine}/pages/0").status_code == 200
    assert staff_c.get(f"/api/documents/{theirs}/pages/0").status_code == 404
    assert sign_in(f"owner@{other}.test").get(f"/api/documents/{mine}/pages/0").status_code == 404


def test_page_pictures_need_sign_in(two, client):
    from tests.backend.integration.test_document_pages import _doc, _pdf

    did = _doc(two["one"]["id"], _pdf(1), pages=1)
    assert client.get(f"/api/documents/{did}/pages/0").status_code == 401
