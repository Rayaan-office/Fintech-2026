"""A bank sync failed whenever the bank changed data while we were paging through it.

Plaid answers TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION and expects the whole read to start
again from the first cursor. We treated it as the bank being down. The read now starts again,
and the pages read before the change are thrown away so nothing is counted twice.
"""

from tests.backend.integration.test_bank_account import _connect, _records, biz, fake_plaid  # noqa: F401


def test_the_read_starts_again(biz, fake_plaid):  # noqa: F811
    _connect(biz)
    fake_plaid.item["released"] = 2
    fake_plaid.push(added=[fake_plaid.txn(list(fake_plaid.items)[-1], "k6")])
    fake_plaid.fail_once["c2"] = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
    r = biz.finance.post("/api/connections/plaid/sync")
    assert r.status_code == 200 and r.json()["counts"]["added"] == 3
    assert len(_records(biz.id)) == 5
