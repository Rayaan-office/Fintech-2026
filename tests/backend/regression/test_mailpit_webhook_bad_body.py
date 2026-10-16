"""A notification whose body was valid JSON but not an object (e.g. a list) crashed the
endpoint with a server error instead of being rejected."""

import pytest


@pytest.mark.parametrize("body", [b'["not", "an", "object"]', b"not json", b'{"ID": ""}', b'{"ID": "../../etc"}'])
def test_bad_notifications_are_rejected(client, body):
    r = client.post("/webhooks/mailpit", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 400
