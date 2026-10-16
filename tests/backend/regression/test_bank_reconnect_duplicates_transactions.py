"""Reconnecting an expired bank connection doubled every bank transaction.

A new bank link gives every account and transaction a new id, so each one was saved again
next to the old copy, and the cash position counted the money twice. Records are now carried
over to the new ids (keeping their matches), and old ones the bank no longer has are voided.
"""

from sqlalchemy import func, select

from app.db import tenant_session
from app.models import Account, Record
from tests.backend.integration.test_bank_account import _connect, biz, fake_plaid  # noqa: F401


def _count(bid, model, **where):
    with tenant_session(bid) as db:
        q = select(func.count()).select_from(model).where(model.source == "plaid")
        for k, v in where.items():
            q = q.where(getattr(model, k) == v)
        return db.scalar(q)


def test_reconnecting_keeps_one_copy(biz, fake_plaid):  # noqa: F811
    _connect(biz)
    fake_plaid.item["released"] = 2
    biz.finance.post("/api/connections/plaid/sync")
    _connect(biz)
    fake_plaid.item["released"] = 2
    biz.finance.post("/api/connections/plaid/sync")
    assert _count(biz.id, Record) == 4 and _count(biz.id, Record, status="void") == 0
    assert _count(biz.id, Account) == 1
