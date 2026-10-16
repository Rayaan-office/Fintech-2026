"""Every genuine Stripe notification was refused with "Invalid signature".

The signature check passed, but stripe-python 16 returns an Event object that is no longer a
dict, and our next line called event.get(...), which raises. The error was caught as a bad
signature, so no notification ever got through.
"""

import json
import time

import stripe
from pydantic import SecretStr

from app.connectors import stripe_conn

SECRET = "whsec_regressiontestsecretnotreal"


def test_a_correctly_signed_notification_is_accepted(monkeypatch):
    monkeypatch.setattr(stripe_conn._s, "stripe_webhook_secret", SecretStr(SECRET))
    body = json.dumps({"id": "evt_1", "object": "event", "type": "charge.succeeded", "livemode": False,
                       "data": {"object": {}}})
    ts = int(time.time())
    sig = stripe.WebhookSignature._compute_signature(f"{ts}.{body}", SECRET)
    event = stripe_conn.verify_webhook(body.encode(), f"t={ts},v1={sig}")
    assert isinstance(event, dict) and event["id"] == "evt_1" and event["type"] == "charge.succeeded"
