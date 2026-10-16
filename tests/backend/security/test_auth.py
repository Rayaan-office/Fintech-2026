"""Sign-in, lockout, two-step sign-in and role checks."""

from tests.backend.conftest import PASSWORD


def test_wrong_password_is_refused(client, businesses):
    r = client.post("/api/auth/login", json={"email": "books@a.test", "password": "nope-nope-nope"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Email or password is incorrect."


def test_unknown_email_gives_the_same_answer(client, businesses):
    r = client.post("/api/auth/login", json={"email": "nobody@a.test", "password": "whatever-123"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Email or password is incorrect."


def test_account_locks_after_repeated_failures(client, businesses):
    for _ in range(5):
        client.post("/api/auth/login", json={"email": "staff@b.test", "password": "wrong-password-1"})
    r = client.post("/api/auth/login", json={"email": "staff@b.test", "password": PASSWORD})
    assert r.status_code == 401


def test_bookkeeper_signs_in_without_two_step(client, businesses):
    r = client.post("/api/auth/login", json={"email": "books@a.test", "password": PASSWORD})
    assert r.status_code == 200
    assert r.json() == {"totp_required": False, "totp_setup_required": False}
    assert client.get("/api/auth/me").json()["user"]["roles"] == ["bookkeeper"]


def test_owner_must_finish_two_step_before_using_the_app(client, businesses):
    r = client.post("/api/auth/login", json={"email": "owner@a.test", "password": PASSWORD})
    assert r.json()["totp_setup_required"] is True
    assert client.get("/api/auth/me").status_code == 401


def test_wrong_two_step_code_is_refused(client, businesses):
    client.post("/api/auth/login", json={"email": "finance@a.test", "password": PASSWORD})
    client.post("/api/auth/totp/setup")
    assert client.post("/api/auth/totp/verify", json={"code": "000000"}).status_code == 401


def test_owner_with_two_step_gets_in(sign_in):
    c = sign_in("owner@a.test")
    me = c.get("/api/auth/me").json()
    assert "manage_users" in me["permissions"]


def test_session_cookie_is_http_only(client, businesses):
    r = client.post("/api/auth/login", json={"email": "books@a.test", "password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_logout_ends_the_session(sign_in):
    c = sign_in("books@a.test")
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").status_code == 401


def test_employee_has_only_receipt_permissions(sign_in):
    perms = sign_in("staff@a.test").get("/api/auth/me").json()["permissions"]
    assert perms == ["submit_receipt", "view_own_submissions"]
