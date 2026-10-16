"""The demo bank account we give Plaid's sandbox as a custom test user."""

import json
from datetime import date

from app.demo.bank import custom_user
from app.demo.story import build, current_balance


def test_the_balance_is_todays_balance_from_the_story():
    acct = custom_user()["override_accounts"][0]
    assert acct["starting_balance"] == current_balance(build()) / 100
    assert (acct["type"], acct["currency"], acct["meta"]["mask"]) == ("depository", "GBP", "4417")


def test_money_in_is_negative_like_plaid_expects():
    story = build()
    txns = custom_user()["override_accounts"][0]["transactions"]
    assert len(txns) == len(story.bank)
    for line, t in zip(story.bank, txns, strict=True):
        assert t["amount"] == -line.amount / 100 and t["description"] == line.description


def test_every_transaction_has_already_happened():
    txns = custom_user()["override_accounts"][0]["transactions"]
    assert all(date.fromisoformat(t["date_posted"]) < date.today() for t in txns)  # future ones would be pending


def test_it_fits_plaids_size_limit():
    # Plaid: about 55 KB at most. (It also says about 250 transactions; 266 work, checked live.)
    assert len(json.dumps(custom_user())) < 50_000
