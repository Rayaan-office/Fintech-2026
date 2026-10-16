"""Only the last 30 days of the bank account ever arrived.

Plaid sends the last 30 days straight after connecting and the rest of the history a few
seconds later. Nothing read the bank again (Plaid can't notify us without a public address),
so five months of transactions never reached the ledger. The background schedule now keeps
reading while Plaid reports the history as unfinished.
"""

from app import scheduler
from tests.backend.integration.test_bank_account import _connect, _records, biz, fake_plaid  # noqa: F401


def test_history_arrives_without_anyone_pressing_sync(biz, fake_plaid):  # noqa: F811
    _connect(biz)
    assert set(_records(biz.id)) == {"k3", "k4"}
    fake_plaid.item["released"] = 2
    scheduler.poll_banks()
    assert set(_records(biz.id)) == {"k1", "k2", "k3", "k4"}
