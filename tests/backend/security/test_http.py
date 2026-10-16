"""Browser security headers and cross-site request protection."""

from fastapi.testclient import TestClient

from app.main import app


def test_security_headers_are_set(client):
    h = client.get("/api/health").headers
    assert "default-src 'self'" in h["content-security-policy"]
    assert "frame-ancestors 'none'" in h["content-security-policy"]
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert h["cache-control"] == "no-store"


def test_changes_from_another_site_are_refused(businesses):
    evil = TestClient(app, headers={"Origin": "https://evil.example"})
    r = evil.post("/api/auth/login", json={"email": "books@a.test", "password": "x"})
    assert r.status_code == 403


def test_changes_without_origin_are_refused(businesses):
    bare = TestClient(app)
    assert bare.post("/api/auth/login", json={"email": "books@a.test", "password": "x"}).status_code == 403


def test_errors_reveal_nothing_internal(client):
    r = client.post("/api/auth/login", json={"email": "not-an-email", "password": ""})
    assert r.status_code == 422
    assert "Traceback" not in r.text and "pydantic" not in r.text.lower()
