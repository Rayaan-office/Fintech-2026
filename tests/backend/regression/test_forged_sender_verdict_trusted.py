"""Any sender could forge the sender-check verdict.

We read SPF, DKIM and DMARC from every Authentication-Results header in the email.
Those headers are plain text that the sender can write, so a fraudster could add
"dmarc=pass" and look genuine. We also marked an email as failing DKIM when we simply
couldn't find the signing key, which is not the same as a forged signature.
"""

from email.message import EmailMessage
from email.policy import SMTP

from app.connectors import email_in


def _raw(*headers: str) -> bytes:
    m = EmailMessage()
    m["From"] = "accounts@acme-supplies.co.uk"
    m["Subject"] = "Invoice"
    m.set_content("Please pay.")
    return "".join(f"Authentication-Results: {h}\r\n" for h in headers).encode() + m.as_bytes(policy=SMTP)


def test_verdict_under_another_servers_name_is_ignored():
    import email
    import email.policy

    raw = _raw("mx.attacker.example; spf=pass; dkim=pass; dmarc=pass")
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    checks = email_in.sender_checks(raw, msg, "acme-supplies.co.uk")
    assert checks["dmarc"] == "none" and checks["receiver_verdict"] is False


def test_signature_with_no_published_key_is_not_called_forged():
    import dkim

    from app.demo import mailkeys

    m = EmailMessage()
    m["From"] = "a@unknown-domain.example"
    m.set_content("Hello")
    raw = m.as_bytes(policy=SMTP)
    # Signed with a key whose public half is published nowhere
    signed = dkim.sign(raw, b"other", b"unknown-domain.example", mailkeys.private_key("signed.example"),
                       include_headers=[b"from"]) + raw
    assert email_in.dkim_check(signed, "unknown-domain.example")["result"] == "temperror"
