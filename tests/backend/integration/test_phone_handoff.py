"""Phone handoff: the QR code's link lets a phone send a few photos for ten minutes, for the person
who made it. The link is stored only as a fingerprint, and each step is in the activity log."""

import hashlib
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.api import handoff
from app.db import tenant_session
from app.demo import documents as demo
from app.main import app
from app.models import Document, HandoffToken
from app.pipeline import ingest


@pytest.fixture(autouse=True)
def _no_processing(monkeypatch):
    monkeypatch.setattr(ingest, "enqueue", lambda *a, **k: None)  # receiving is what we test here


def _pdf():
    return demo.render(demo.acme_bill(number="PH-1", issue=date.today()))


def _start(c):
    r = c.post("/api/handoff")
    assert r.status_code == 200, r.text
    body = r.json()
    return body, body["url"].split("/m/", 1)[1]


phone = TestClient(app)  # no session cookie and no Origin header, like a phone opening the link


def test_a_phone_sends_a_photo_that_arrives_for_the_person_who_made_the_code(businesses, sign_in):
    books = sign_in("books@a.test")
    body, token = _start(books)
    assert body["max_uploads"] == handoff.MAX_UPLOADS
    page = phone.get(f"/api/handoff/upload/{token}").json()
    assert page["business"] == "Business A" and page["left"] == handoff.MAX_UPLOADS

    r = phone.post(f"/api/handoff/upload/{token}", files={"file": ("receipt.pdf", _pdf(), "application/pdf")})
    assert r.status_code == 200, r.text
    assert r.json()["left"] == handoff.MAX_UPLOADS - 1
    with tenant_session(businesses["a"]) as db:
        d = db.get(Document, r.json()["id"])
        assert d.source == "photo" and d.filename == "receipt.pdf"
        events = db.execute(text("SELECT event FROM audit_log WHERE actor = :a ORDER BY seq"),
                            {"a": f"user:{d.submitted_by}"}).scalars().all()
        assert "handoff_created" in events and "document_received" in events
    # The computer sees it arrive
    seen = books.get(f"/api/handoff/{body['id']}").json()
    assert [x["filename"] for x in seen["received"]] == ["receipt.pdf"] and not seen["expired"]


def test_the_link_is_stored_only_as_a_fingerprint(businesses, sign_in):
    body, token = _start(sign_in("books@a.test"))
    secret = token.split(".", 1)[1]
    with tenant_session(businesses["a"]) as db:
        t = db.get(HandoffToken, body["id"])
        assert t.token_hash == hashlib.sha256(secret.encode()).hexdigest() and secret not in t.token_hash


def test_an_expired_or_used_up_link_stops_working(businesses, sign_in):
    body, token = _start(sign_in("books@a.test"))
    with tenant_session(businesses["a"]) as db:
        db.get(HandoffToken, body["id"]).expires_at = datetime.now(UTC) - timedelta(seconds=1)
    assert phone.get(f"/api/handoff/upload/{token}").status_code == 404
    assert phone.post(f"/api/handoff/upload/{token}", files={"file": ("r.pdf", _pdf(), "application/pdf")}).status_code == 404

    body, token = _start(sign_in("books@a.test"))
    with tenant_session(businesses["a"]) as db:
        db.get(HandoffToken, body["id"]).used_count = handoff.MAX_UPLOADS
    r = phone.post(f"/api/handoff/upload/{token}", files={"file": ("r.pdf", _pdf(), "application/pdf")})
    assert r.status_code == 404 and "Scan a new code" in r.json()["detail"]


def test_a_wrong_or_altered_link_gets_nothing(businesses, sign_in):
    _, token = _start(sign_in("books@a.test"))
    head, secret = token.split(".", 1)
    for bad in ("nonsense", f"{head}.{'x' * 43}", f"{head}.short", f"AAAAAAAAAAAAAAAAAAAAAA.{secret}"):
        assert phone.get(f"/api/handoff/upload/{bad}").status_code == 404, bad


def test_a_link_from_one_business_never_lands_in_another(businesses, sign_in):
    _, token = _start(sign_in("books@a.test"))
    secret = token.split(".", 1)[1]
    other = f"{handoff._token(businesses['b'], secret)}"
    assert phone.post(f"/api/handoff/upload/{other}", files={"file": ("r.pdf", _pdf(), "application/pdf")}).status_code == 404
    with tenant_session(businesses["b"]) as db:
        assert not db.execute(select(Document).where(Document.filename == "r.pdf")).first()


def test_unsafe_files_are_refused_as_for_any_upload(businesses, sign_in):
    _, token = _start(sign_in("books@a.test"))
    r = phone.post(f"/api/handoff/upload/{token}", files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")})
    assert r.status_code == 400


def test_only_the_person_who_made_the_code_can_watch_it(businesses, sign_in):
    body, _ = _start(sign_in("books@a.test"))
    assert sign_in("finance@a.test").get(f"/api/handoff/{body['id']}").status_code == 404
    assert sign_in("books@b.test").get(f"/api/handoff/{body['id']}").status_code == 404


def test_in_development_the_phone_gets_this_computers_wifi_address(monkeypatch, settings):
    monkeypatch.setattr(settings, "handoff_base_url", None)
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "app_base_url", "http://localhost:5173")
    monkeypatch.setattr(handoff, "_lan_address", lambda: "192.168.1.20")
    assert handoff.phone_base_url() == "http://192.168.1.20:5173"
    monkeypatch.setattr(settings, "handoff_base_url", "https://cocent.example/")
    assert handoff.phone_base_url() == "https://cocent.example"
