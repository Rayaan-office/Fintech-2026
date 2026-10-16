"""A pending bank payment lost its record (and any match on it) when it posted.

Plaid gives the posted transaction a new id and removes the pending one. We voided the pending
record and saved the posted one as new, so a supplier payment matched while pending became
unmatched. The posted transaction now takes over the pending record.
"""

from tests.backend.integration.test_bank_account import _connect, _records, biz, fake_plaid  # noqa: F401


def test_posting_keeps_the_record(biz, fake_plaid):  # noqa: F811
    _connect(biz)
    item = list(fake_plaid.items)[-1]
    fake_plaid.push(added=[fake_plaid.txn(item, "k5p", pending=True)])
    biz.finance.post("/api/connections/plaid/sync")
    pending_id = _records(biz.id)["k5p"].id
    fake_plaid.push(added=[fake_plaid.txn(item, "k5", pending_transaction_id=f"{item}-k5p")],
                    removed=[{"transaction_id": f"{item}-k5p"}])
    biz.finance.post("/api/connections/plaid/sync")
    recs = _records(biz.id)
    assert recs["k5"].id == pending_id and recs["k5"].status == "posted" and "k5p" not in recs
