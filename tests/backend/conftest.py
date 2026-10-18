"""Shared test setup.

Tests run against a separate database (copilot_test) so they can never touch development data.
Outside services (Stripe, Plaid, QuickBooks, OpenRouter) are replaced with fakes unless a test
is marked `live`, which is skipped by default.
"""

import os
import sys
from pathlib import Path

TEST_DB = os.environ.get("COPILOT_TEST_DB", "copilot_test")

_ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(_ROOT / "backend"), str(_ROOT)]

os.environ["POSTGRES_DB"] = TEST_DB
os.environ.setdefault("APP_ENV", "test")
os.environ["APP_BASE_URL"] = "http://testserver"

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import bootstrap  # noqa: E402

bootstrap.ensure_database(TEST_DB)
bootstrap.run()

from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.security.http import limiter  # noqa: E402
from app.seed import create_business  # noqa: E402

PASSWORD = "correct-horse-battery-staple"


def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", help="also run tests that call the real sandboxes")


def pytest_configure(config):
    config.addinivalue_line("markers", "live: calls a real sandbox service")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="needs --live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


def _truncate():
    engine = bootstrap._engine_for()
    names = ", ".join(f'"{t}"' for t in Base.metadata.tables) + ", vault.pii_values"
    with engine.connect() as c:
        c.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


def people(prefix: str):
    return [
        (f"owner@{prefix}.test", "Owner", ["owner"], None, False),
        (f"finance@{prefix}.test", "Finance", ["finance_manager"], 1_000_000, False),
        (f"books@{prefix}.test", "Books", ["bookkeeper"], None, False),
        (f"staff@{prefix}.test", "Staff", ["employee"], None, False),
    ]


@pytest.fixture(scope="session")
def businesses():
    _truncate()
    a = create_business("Business A", people("a"), {e: PASSWORD for e, *_ in people("a")}, inbox="bills@a.test")
    b = create_business("Business B", people("b"), {e: PASSWORD for e, *_ in people("b")}, inbox="bills@b.test")
    return {"a": a.id, "b": b.id}


@pytest.fixture(autouse=True)
def _reset_limits():
    limiter.reset()
    yield


@pytest.fixture
def client():
    return TestClient(app, headers={"Origin": "http://testserver"})


@pytest.fixture
def sign_in(businesses):
    """Returns a function that signs in as a role (completing two-step sign-in if needed)."""
    import pyotp

    secrets: dict[str, str] = {}

    def _sign_in(email: str) -> TestClient:
        c = TestClient(app, headers={"Origin": "http://testserver"})
        r = c.post("/api/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        body = r.json()
        if body["totp_setup_required"]:
            secrets[email] = c.post("/api/auth/totp/setup").json()["secret"]
            body["totp_required"] = True
        if body["totp_required"]:
            secret = secrets.get(email) or _known_secret(email)
            r = c.post("/api/auth/totp/verify", json={"code": pyotp.TOTP(secret).now()})
            assert r.status_code == 200, r.text
        return c

    def _known_secret(email):
        from sqlalchemy import select

        from app.db import global_session
        from app.models import User
        from app.security.crypto import tokens

        with global_session() as db:
            u = db.execute(select(User).where(User.email == email)).scalar_one()
            return tokens.open_str(u.totp_secret_enc)

    return _sign_in


@pytest.fixture
def settings():
    return get_settings()


@pytest.fixture
def fake_ai(monkeypatch):
    """Replace the AI with a scripted one. Push forms (or exceptions) in the order they should be returned."""
    from app.ai import gateway

    calls: list[dict] = []
    script: list = []

    def complete_json(business_id, purpose, instructions, data_text, schema, model=None, max_tokens=None, context=""):
        from app.privacy.redact import final_scan

        sent = (context + "\n\n" if context else "") + f"<data>\n{data_text}\n</data>"
        final_scan(sent)  # the real privacy scan still runs
        calls.append({"purpose": purpose, "model": model, "sent": sent, "context": context})
        item = script.pop(0)
        if isinstance(item, Exception):
            raise item
        data = item(data_text) if callable(item) else item
        return gateway.AIResult(data=schema.model_validate(data), model=model or "fake", provider="fake",
                                sent_text=sent, gateway_labels=False)

    monkeypatch.setattr(gateway, "complete_json", complete_json)
    from app.pipeline import ingest

    monkeypatch.setattr(ingest, "SYNC_FOR_TESTS", True)

    class Fake:
        def push(self, *items):
            script.extend(items)

        @property
        def calls(self):
            return calls

    return Fake()


def acme_form(bill, **overrides) -> dict:
    """The form a perfect reader would fill in for a demo bill."""
    s = bill.supplier
    form = {
        "doc_type": "bill", "counterparty_name": s.name, "issue_date": bill.issue.isoformat(),
        "due_date": bill.due.isoformat(), "currency": "GBP", "reference": bill.number,
        "line_items": [{"description": d, "quantity": str(q), "unit_price": f"{p / 100:.2f}", "amount": f"{q * p / 100:.2f}"}
                       for d, q, p in bill.lines],
        "subtotal": f"{bill.subtotal / 100:.2f}", "tax": f"{bill.vat / 100:.2f}", "total": f"{bill.total / 100:.2f}",
        "payment_bank_account": "[BANK_ACCOUNT_1]", "payment_sort_code": "[SORT_CODE_1]",
        "contact_email": "[EMAIL_1]", "contact_phone": "[PHONE_1]", "address": "[ADDRESS_1]", "category_hint": "stock",
    }
    form.update(overrides)
    return form
