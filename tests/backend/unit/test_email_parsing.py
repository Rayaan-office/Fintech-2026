"""Reading incoming emails: sender checks, refusals, attachments and text."""

import email
import email.policy
from email.message import EmailMessage
from email.policy import SMTP

import dkim
import pytest

from app.connectors import email_in, email_out
from app.demo import mailkeys

INBOX = "bills@demo-business.test"


def _msg(sender="accounts@signed.example", subject="Invoice 1", body="Please find the invoice attached.") -> EmailMessage:
    m = EmailMessage()
    m["From"] = sender
    m["To"] = INBOX
    m["Subject"] = subject
    m["Message-ID"] = "<abc-123@signed.example>"
    m.set_content(body)
    return m


def _signed(m: EmailMessage, domain="signed.example") -> bytes:
    raw = m.as_bytes(policy=SMTP)
    return dkim.sign(raw, b"demo", domain.encode(), mailkeys.private_key(domain),
                     include_headers=[b"from", b"to", b"subject", b"message-id"]) + raw


def _parse(raw: bytes) -> EmailMessage:
    return email.message_from_bytes(raw, policy=email.policy.default)


# ── Our receiving server's verdict ─────────────────────────────────────────


def test_only_our_receiving_servers_verdict_counts(settings):
    raw = (f"Authentication-Results: {settings.mail_authserv_id}; spf=fail; dkim=none; dmarc=fail\r\n"
           "Authentication-Results: mx.google.com; spf=pass; dkim=pass; dmarc=pass\r\n").encode()
    raw += _msg().as_bytes(policy=SMTP)
    assert email_in.trusted_results(_parse(raw)) == {"spf": "fail", "dkim": "none", "dmarc": "fail"}


def test_a_verdict_written_by_anyone_else_is_ignored():
    raw = b"Authentication-Results: mx.google.com; spf=pass; dkim=pass; dmarc=pass\r\n" + _msg().as_bytes(policy=SMTP)
    assert email_in.trusted_results(_parse(raw)) == {}


def test_the_topmost_of_our_verdicts_wins(settings):
    raw = (f"Authentication-Results: {settings.mail_authserv_id}; dmarc=fail\r\n"
           f"Authentication-Results: {settings.mail_authserv_id}; dmarc=pass\r\n").encode()
    raw += _msg().as_bytes(policy=SMTP)
    assert email_in.trusted_results(_parse(raw))["dmarc"] == "fail"


# ── Our own signature check ────────────────────────────────────────────────


def test_valid_signature_passes_and_is_aligned():
    out = email_in.dkim_check(_signed(_msg()), "signed.example")
    assert out == {"result": "pass", "domain": "signed.example", "aligned": True}


def test_changed_email_fails_the_signature():
    raw = _signed(_msg()).replace(b"Please find", b"Please pay")
    assert email_in.dkim_check(raw, "signed.example")["result"] == "fail"


def test_signature_from_another_domain_is_not_aligned():
    out = email_in.dkim_check(_signed(_msg(), "mailer.example"), "signed.example")
    assert out["result"] == "pass" and out["aligned"] is False


def test_unsigned_email():
    assert email_in.dkim_check(_msg().as_bytes(policy=SMTP), "signed.example")["result"] == "none"


# ── Refusals ───────────────────────────────────────────────────────────────


def _reason(m: EmailMessage, checks=None):
    sender = m["From"].addresses[0].addr_spec.lower()
    return email_in.refusal_reason(m, sender, checks or {}, INBOX)


def test_genuine_email_is_not_refused():
    assert _reason(_msg(), {"spf": "pass", "dkim": "pass", "dmarc": "pass"}) is None


def test_mail_loop_is_refused():
    assert "bills inbox" in _reason(_msg(sender=INBOX))


@pytest.mark.parametrize("header,value", [("Auto-Submitted", "auto-replied"), ("Precedence", "auto_reply"),
                                          ("X-Autoreply", "yes")])
def test_automatic_replies_are_refused(header, value):
    m = _msg()
    m[header] = value
    assert "automatic reply" in _reason(m)


def test_delivery_reports_are_refused():
    m = _msg()
    m.make_mixed()
    m.replace_header("Content-Type", 'multipart/report; report-type=delivery-status; boundary="b"')
    assert "delivery report" in _reason(_parse(m.as_bytes()))


def test_dmarc_failure_is_refused():
    assert "DMARC" in _reason(_msg(), {"dmarc": "fail"})


def test_broken_signature_from_the_senders_own_domain_is_refused():
    assert "forged" in _reason(_msg(), {"dkim_own": "fail", "dkim_aligned": True})


def test_broken_signature_from_another_domain_is_only_a_warning():
    assert _reason(_msg(), {"dkim_own": "fail", "dkim_aligned": False}) is None


# ── Attachments and text ───────────────────────────────────────────────────


def test_logo_in_the_email_text_is_not_a_document():
    m = _msg()
    m.add_alternative('<p>Receipt</p><img src="cid:logo@x">', subtype="html")
    m.get_payload()[1].add_related(b"\x89PNG small logo", maintype="image", subtype="png", cid="<logo@x>")
    m.add_attachment(b"%PDF-1.4 bill", maintype="application", subtype="pdf", filename="bill.pdf")
    assert [n for n, _ in email_in.attachments(_parse(m.as_bytes()))] == ["bill.pdf"]


def test_attachments_inside_a_forwarded_email_are_found():
    inner = _msg()
    inner.add_attachment(b"%PDF-1.4 bill", maintype="application", subtype="pdf", filename="original.pdf")
    outer = _msg(sender="owner@demo-business.test", subject="Fwd: Invoice 1", body="See below")
    outer.add_attachment(inner)
    assert [n for n, _ in email_in.attachments(_parse(outer.as_bytes()))] == ["original.pdf"]


@pytest.mark.parametrize("name,safe", [("../../etc/passwd", "passwd"), ("C:\\Users\\x\\bill.pdf", "bill.pdf"),
                                       ("bill\x00.pdf", "bill.pdf"), ("...", "attachment"), (None, "attachment")])
def test_attachment_names_are_made_safe(name, safe):
    assert email_in.safe_filename(name) == safe


def test_html_only_email_is_read_as_text_without_scripts():
    m = EmailMessage()
    m["From"] = "a@b.example"
    m.set_content("<html><script>alert(1)</script><p>Total charged:</p><p>£94.80</p></html>", subtype="html")
    assert email_in.body_text(_parse(m.as_bytes())) == "Total charged:\n£94.80"


def test_email_without_message_id_gets_a_content_fingerprint():
    m = _msg()
    del m["Message-ID"]
    raw = m.as_bytes()
    assert email_in.message_key(_parse(raw), raw).startswith("sha256:")


# ── Outgoing checks that need no database ──────────────────────────────────


@pytest.mark.parametrize("to,subject,body", [
    ("not-an-address", "Reminder", "Hello"),
    ("a@b.example\r\nBcc: x@evil.example", "Reminder", "Hello"),
    ("a@b.example", "Reminder\r\nBcc: x@evil.example", "Hello"),
    ("a@b.example", "Reminder", "Dear [PERSON_1], please pay."),
    ("a@b.example", "Reminder", ""),
])
def test_unsafe_outgoing_emails_are_refused(to, subject, body):
    with pytest.raises(email_out.SendRefused):
        email_out.check(to, subject, body)
