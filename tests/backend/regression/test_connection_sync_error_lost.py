"""A failed sync left the connection card saying "connected", with no error.

Connectors recorded the error on the connection inside the sync's own transaction, which was
then rolled back by the failure. A business already linked to the Stripe account was also told
"We couldn't reach Stripe" instead of the real reason.
"""

from app.connectors import stripe_conn
from app.seed import create_business
from tests.backend.conftest import PASSWORD, people


def test_failed_sync_is_shown_on_the_card(businesses, sign_in, monkeypatch):
    def down(path, params=None):
        raise stripe_conn.StripeError(503, "Stripe answered 503")

    monkeypatch.setattr(stripe_conn, "_get", down)
    create_business("Business R3", people("r3"), {e: PASSWORD for e, *_ in people("r3")}, inbox="bills@r3.test")
    c = sign_in("finance@r3.test")
    assert c.post("/api/connections/stripe/sync").status_code == 502
    card = next(x for x in c.get("/api/connections").json()["items"] if x["provider"] == "stripe")
    assert card["status"] == "error" and "couldn't reach" in card["error"]


def test_account_linked_elsewhere_gets_the_real_reason(businesses, sign_in, monkeypatch):
    from app.api import connections

    status, message, _ = connections._failure("stripe", PermissionError("taken"))
    assert status == 409 and "another business" in message
