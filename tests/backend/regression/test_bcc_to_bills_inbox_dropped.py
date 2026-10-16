"""Bills sent to the bills inbox by Bcc were dropped.

We looked for the inbox only in the To and Cc addresses. A supplier who Bccs the bills
inbox (common when emailing the owner directly) never reached us. Mailpit lists envelope
recipients missing from the headers as Bcc.
"""

from app.connectors import mailpit


def test_inbox_found_in_bcc(businesses):
    summary = {"To": [{"Address": "owner@cafe.example"}], "Cc": [], "Bcc": [{"Address": "BILLS@a.test"}]}
    assert mailpit._routes(summary) == {businesses["a"]: "bills@a.test"}


def test_one_email_to_two_businesses_reaches_both(businesses):
    summary = {"To": [{"Address": "bills@a.test"}], "Cc": [{"Address": "bills@b.test"}]}
    assert set(mailpit._routes(summary)) == {businesses["a"], businesses["b"]}
