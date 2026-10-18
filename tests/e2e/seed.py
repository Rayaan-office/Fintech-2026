"""A fresh copy of the demo story for the browser journeys, in its own database (copilot_e2e), so the
journeys never touch development data. Run before each journey run; it starts from empty every time.

Writes the sign-ins to tests/e2e/e2e-credentials.local.json (git-ignored, never printed) and the bills the
journeys upload to tests/e2e/.data/.
Run from backend/:  .venv/bin/python ../tests/e2e/seed.py
"""

import json
import os
import secrets
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT)]

DB = "copilot_e2e"
os.environ["COPILOT_TEST_DB"] = DB  # the backend test setup creates and empties this database

from tests.backend import conftest, story_books  # noqa: E402

from app.db import tenant_session  # noqa: E402
from app.demo import documents  # noqa: E402
from app.handlers import run_matching  # noqa: E402
from app.seed import create_business  # noqa: E402

PEOPLE = [
    ("owner@e2e-bakery.test", "Alex Morgan", ["owner"], None, False),
    ("books@e2e-bakery.test", "Jordan Lee", ["bookkeeper"], None, False),
    ("staff@e2e-bakery.test", "Riley Chen", ["employee"], None, False),
]


def main() -> None:
    conftest._truncate()
    passwords = {email: secrets.token_urlsafe(12) for email, *_ in PEOPLE}
    biz = create_business("E2E Bakery Ltd", PEOPLE, passwords, inbox="bills@e2e-bakery.test")
    story_books.load(biz.id)
    with tenant_session(biz.id) as db:
        run_matching(db, biz.id)

    creds = HERE / "e2e-credentials.local.json"
    creds.write_text(json.dumps(passwords, indent=2))
    creds.chmod(0o600)
    data = HERE / ".data"
    data.mkdir(exist_ok=True)
    (data / "two-step.local.json").unlink(missing_ok=True)  # the sign-ins above start without two-step
    (data / "acme-bill.pdf").write_bytes(documents.render(documents.acme_bill()))
    (data / "acme-new-bank.pdf").write_bytes(documents.render(documents.acme_fraud_bill()))
    print(f"{DB} ready: E2E Bakery Ltd with the demo story")


if __name__ == "__main__":
    main()
