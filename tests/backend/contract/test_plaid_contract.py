"""Our bank connector still understands the real Plaid sandbox (run with --live).

Creates a test bank link from the story, reads it until the history is complete, checks every
transaction fits our shapes, then expires its login and removes it."""

import json
import time

import pytest

from app.connectors import plaid_conn
from app.demo.bank import custom_user
from app.demo.story import build, current_balance

pytestmark = pytest.mark.live


@pytest.fixture(scope="module")
def link():
    pub = plaid_conn._post("/sandbox/public_token/create", {
        "institution_id": plaid_conn.SANDBOX_BANK, "initial_products": ["transactions"],
        "options": {"override_username": "user_custom", "override_password": json.dumps(custom_user()),
                    "transactions": {"days_requested": 365}}})
    token = plaid_conn._post("/item/public_token/exchange", {"public_token": pub["public_token"]})["access_token"]
    yield token
    plaid_conn._post("/item/remove", {"access_token": token})


def _read_all(token) -> tuple[list[dict], str]:
    added, cursor, status = [], None, ""
    deadline = time.time() + 90
    while time.time() < deadline:
        page = plaid_conn._post("/transactions/sync", {"access_token": token, "count": 500,
                                                       **({"cursor": cursor} if cursor else {})})
        added += page["added"]
        cursor, status = page["next_cursor"] or cursor, page["transactions_update_status"]
        if page["has_more"]:
            continue
        if status == plaid_conn.HISTORY_DONE:
            break
        time.sleep(3)
    return added, status


def test_the_sandbox_bank_is_a_uk_test_bank_without_an_oauth_screen():
    bank = plaid_conn._post("/institutions/get_by_id", {"institution_id": plaid_conn.SANDBOX_BANK,
                                                        "country_codes": ["GB"]})["institution"]
    assert "GB" in bank["country_codes"] and "transactions" in bank["products"] and bank["oauth"] is False


def test_the_whole_story_arrives_in_our_shapes(link):
    added, status = _read_all(link)
    assert status == plaid_conn.HISTORY_DONE
    txns = [plaid_conn.PlaidTxn.model_validate(t) for t in added]
    assert len({t.transaction_id for t in txns}) == len(build().bank)
    assert {t.iso_currency_code for t in txns} == {"GBP"}


def test_the_balance_matches_the_story(link):
    accts = [plaid_conn.PlaidAccount.model_validate(a)
             for a in plaid_conn._post("/accounts/get", {"access_token": link})["accounts"]]
    assert len(accts) == 1 and accts[0].mask == "4417"
    assert plaid_conn._pence(accts[0].balances.current) == current_balance(build())


def test_an_expired_login_is_reported_as_expired(link):
    plaid_conn._post("/sandbox/item/reset_login", {"access_token": link})
    with pytest.raises(plaid_conn.PlaidError) as e:
        plaid_conn._post("/transactions/sync", {"access_token": link})
    assert e.value.expired
