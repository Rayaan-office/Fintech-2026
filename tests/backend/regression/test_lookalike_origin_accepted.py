"""A change request from a look-alike web address was accepted.

We checked that the request's origin started with our app's address, so a site at
http://localhost:5173.evil.com passed the check meant to block cross-site requests.
"""

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


def test_a_lookalike_origin_is_refused(businesses):
    lookalike = TestClient(app, headers={"Origin": get_settings().app_base_url.rstrip("/") + ".evil.com"})
    r = lookalike.post("/api/auth/login", json={"email": "books@a.test", "password": "x"})
    assert r.status_code == 403


def test_our_own_origin_is_still_allowed(businesses):
    ours = TestClient(app, headers={"Origin": get_settings().app_base_url.rstrip("/")})
    r = ours.post("/api/auth/login", json={"email": "books@a.test", "password": "x"})
    assert r.status_code != 403
