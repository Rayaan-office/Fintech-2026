"""Correcting a field a second time lost the AI's own answer.

Each correction stored the value it replaced as the AI's answer, so after two edits the second
correction said the AI had read the person's first edit, and learning would learn from a typo.
Every correction now keeps the AI's original answer and the supplier it belongs to.
"""

from sqlalchemy import select
from tests.backend.learning_steps import bill, correct, fresh_business, read

import app.handlers  # noqa: F401  (registers approval handlers)
from app.db import tenant_session
from app.models import Correction


def test_both_corrections_keep_the_ai_answer(businesses, fake_ai, sign_in):
    biz = fresh_business()
    c = sign_in(f"books@{biz['tag']}.test")
    did = read(biz["id"], fake_ai, bill("SC-1"))
    correct(c, did, category_hint="packagng")
    correct(c, did, category_hint="packaging")
    with tenant_session(biz["id"]) as db:
        rows = db.execute(select(Correction).where(Correction.field == "category_hint")
                          .order_by(Correction.created_at)).scalars().all()
        assert [(r.ai_value, r.human_value) for r in rows] == [("stock", "packagng"), ("stock", "packaging")]
        assert all(r.counterparty_id is not None for r in rows)
