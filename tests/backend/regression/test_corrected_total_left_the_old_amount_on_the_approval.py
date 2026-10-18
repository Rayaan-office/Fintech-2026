"""Correcting the total on a bill waiting for approval left the old amount on the approval.

The approver saw the amount the AI had read, and approval limits used it, while the bill was
recorded with the corrected amount. The waiting approval now shows the corrected amount.
"""

from tests.backend.learning_steps import bill, correct, fresh_business, read, waiting

import app.handlers  # noqa: F401  (registers approval handlers)


def test_the_approval_shows_the_corrected_amount(businesses, fake_ai, sign_in):
    biz = fresh_business()
    c = sign_in(f"books@{biz['tag']}.test")
    b = bill("WT-1")
    did = read(biz["id"], fake_ai, b)
    [before] = waiting(c, did)
    assert before["amount_minor"] == b.total
    correct(c, did, total="460.00", subtotal="383.33", tax="76.67")
    [after] = waiting(c, did)
    assert after["id"] != before["id"] and after["amount_minor"] == 46000 and "£460.00" in after["summary"]
    assert "Corrected by a person while it waited for approval." in after["reasons"]
