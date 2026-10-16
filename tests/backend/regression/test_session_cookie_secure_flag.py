"""Bug: the session cookie was marked Secure whenever APP_ENV was not "development",
so on a plain-HTTP address the browser dropped it and every user was signed out at once.
Fix: mark it Secure exactly when the app's own address uses HTTPS."""

from tests.backend.conftest import PASSWORD


def test_cookie_is_sent_back_on_http_address(client, businesses):
    client.post("/api/auth/login", json={"email": "books@a.test", "password": PASSWORD})
    assert client.get("/api/auth/me").status_code == 200
