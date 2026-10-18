"""PDF pages shown as pictures in the review view: a real PNG for each page, 404 beyond the last
page or for anything that is not a PDF, and exactly the same access as the original."""

import hashlib
import uuid

import fitz
import pytest
from sqlalchemy import select
from tests.backend import story_books

from app import archive
from app.db import global_session, tenant_session
from app.models import Document, User


def _pdf(pages: int) -> bytes:
    doc = fitz.open()
    for i in range(pages):
        doc.new_page(width=595, height=842).insert_text((72, 72), f"Page {i + 1} of a test bill")
    return doc.tobytes()


def _user_id(email: str):
    with global_session() as db:
        return db.execute(select(User.id).where(User.email == email)).scalar_one()


def _doc(bid, data: bytes, mime="application/pdf", pages: int | None = None, submitted_by=None) -> str:
    key, digest = archive.put(bid, data)
    with tenant_session(bid) as db:
        d = Document(business_id=bid, source="upload", status="approved", stage="done", filename="bill.pdf",
                     mime=mime, size_bytes=len(data), pages=pages, sha256=digest, object_key=key, doc_type="bill",
                     submitted_by=submitted_by)
        db.add(d)
        db.flush()
        return str(d.id)


@pytest.fixture(scope="module")
def docs(businesses):
    """In a business of its own, so signing in here changes nothing for other tests."""
    a, tag = story_books.new_business()
    staff = _user_id(f"staff@{tag}.test")
    png = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), False).tobytes("png")
    return {
        "bid": a, "tag": tag,
        "pdf": _doc(a, _pdf(2), pages=2),
        "unknown_pages": _doc(a, _pdf(1)),
        "staff_pdf": _doc(a, _pdf(1), pages=1, submitted_by=staff),
        "photo": _doc(a, png, mime="image/png", pages=1),
        "not_really_pdf": _doc(a, b"%PDF-1.4 not a real pdf " + uuid.uuid4().bytes, pages=1),
    }


def _page(c, did, n):
    return c.get(f"/api/documents/{did}/pages/{n}")


def test_first_page_is_a_png(docs, sign_in):
    r = _page(sign_in(f"owner@{docs['tag']}.test"), docs["pdf"], 0)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "private, max-age=300"
    assert r.headers["x-content-type-options"] == "nosniff"
    pix = fitz.Pixmap(r.content)
    assert abs(pix.width - 595 * 1.5) <= 1 and abs(pix.height - 842 * 1.5) <= 1  # about 1.5 times the page


def test_each_page_is_its_own_picture(docs, sign_in):
    c = sign_in(f"owner@{docs['tag']}.test")
    one, two = _page(c, docs["pdf"], 0).content, _page(c, docs["pdf"], 1).content
    assert two.startswith(b"\x89PNG\r\n\x1a\n") and hashlib.sha256(one).digest() != hashlib.sha256(two).digest()


def test_out_of_range_is_not_found(docs, sign_in):
    c = sign_in(f"owner@{docs['tag']}.test")
    assert _page(c, docs["pdf"], 2).status_code == 404
    assert _page(c, docs["pdf"], -1).status_code == 404
    assert _page(c, docs["pdf"], 10_000).status_code == 404
    assert _page(c, docs["unknown_pages"], 0).status_code == 200  # page count not stored: the file decides
    assert _page(c, docs["unknown_pages"], 1).status_code == 404
    assert _page(c, docs["pdf"], "first").status_code == 422


def test_not_a_pdf_is_not_found(docs, sign_in):
    c = sign_in(f"owner@{docs['tag']}.test")
    assert _page(c, docs["photo"], 0).status_code == 404
    assert _page(c, docs["not_really_pdf"], 0).status_code == 404
    assert _page(c, uuid.uuid4(), 0).status_code == 404


def test_viewing_a_page_is_in_the_activity_log(docs, sign_in):
    from app.models import AuditEntry

    _page(sign_in(f"books@{docs['tag']}.test"), docs["pdf"], 1)
    with tenant_session(docs["bid"]) as db:
        last = db.execute(select(AuditEntry).where(AuditEntry.subject == f"document:{docs['pdf']}")
                          .order_by(AuditEntry.seq.desc()).limit(1)).scalar_one()
        assert (last.event, last.details) == ("original_viewed", {"page": 1})
