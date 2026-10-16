"""The demo bank account as a Plaid Sandbox custom user, generated from the story."""

from .story import build, current_balance


def custom_user() -> dict:
    story = build()
    txns = [{
        "date_transacted": b.day.isoformat(),
        "date_posted": b.day.isoformat(),
        "amount": round(-b.amount / 100, 2),  # Plaid: positive = money out
        "description": b.description,
        "currency": "GBP",
    } for b in story.bank]
    return {
        "override_accounts": [{
            "type": "depository",
            "subtype": "checking",
            "currency": "GBP",
            # Plaid reports this as today's balance; the transactions are the history behind it
            "starting_balance": current_balance(story) / 100,
            "meta": {"name": "Business Current Account", "official_name": "Demo Business Ltd Current Account",
                     "mask": "4417"},
            "numbers": {"bacs": {"account": "31926819", "sort_code": "601613"}},
            "transactions": txns,
        }],
    }
