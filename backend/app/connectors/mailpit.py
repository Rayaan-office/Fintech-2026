"""Email inbox. Demo: Mailpit test inbox. Each email is processed once (by Message-ID).

Mailpit's notification only says "something arrived"; we then read the message from
Mailpit ourselves and check it was sent to a connected bills inbox.
Sender checks: we read the receiving server's Authentication-Results header (SPF, DKIM,
DMARC) and verify the DKIM signature ourselves.
"""

import email
import email.policy
import re
import smtplib
from email.message import EmailMessage

from ..config import get_settings
from ..db import global_session, tenant_session
from ..security import audit
from . import outbound
from .common import lookup_route, seen_before

_s = get_settings()
API = _s.mailpit_api_url.rstrip("/") + "/api/v1"
_RESULT = re.compile(r"\b(spf|dkim|dmarc)=(\w+)", re.I)


def _get(path: str, raw: bool = False):
    with outbound.client(timeout=15) as http:
        r = http.get(f"{API}{path}")
    r.raise_for_status()
    return r.content if raw else r.json()


def sender_checks(raw: bytes, msg: email.message.Message) -> dict:
    out = {"spf": "none", "dkim": "none", "dmarc": "none"}
    for header in msg.get_all("Authentication-Results", []) or []:
        for k, v in _RESULT.findall(str(header)):
            out[k.lower()] = v.lower()
    if msg.get("DKIM-Signature"):
        try:
            import dkim

            out["dkim_verified"] = bool(dkim.verify(raw, timeout=5))
            if not out["dkim_verified"]:
                out["dkim"] = "fail"
        except Exception:
            out["dkim_verified"] = False
    return out


def handle_new_message(message_id: str) -> list[str]:
    """Called when Mailpit says a message arrived. Returns the IDs of documents created."""
    from ..pipeline import ingest

    summary = _get(f"/message/{message_id}")
    recipients = [a.get("Address", "").lower() for a in (summary.get("To") or []) + (summary.get("Cc") or [])]
    with global_session() as db:
        business_id = next((b for b in (lookup_route(db, "email", r) for r in recipients) if b), None)
    if not business_id:
        return []  # not sent to a connected bills inbox
    msg_id = summary.get("MessageID") or message_id
    with tenant_session(business_id) as db:
        if seen_before(db, business_id, "email", msg_id):
            audit.record(db, business_id, "system", "email_duplicate_ignored", details={"message_id": msg_id[:200]})
            return []
    raw = _get(f"/message/{message_id}/raw", raw=True)
    parsed = email.message_from_bytes(raw, policy=email.policy.default)
    checks = sender_checks(raw, parsed)
    sender = (summary.get("From") or {}).get("Address", "")
    domain = sender.split("@")[-1].lower() if "@" in sender else None
    created = []
    attachments = summary.get("Attachments") or []
    for att in attachments[:10]:
        data = _get(f"/message/{message_id}/part/{att['PartID']}", raw=True)
        try:
            created.append(str(ingest.receive(business_id, data, att.get("FileName") or "attachment", "email",
                                              email_message_id=msg_id, sender_domain=domain, sender_checks=checks)))
        except ingest.Rejected:
            pass
    if not attachments:
        body = (summary.get("Text") or "").strip()
        if len(body) > 40:
            text = f"Subject: {summary.get('Subject', '')}\n\n{body}"
            created.append(str(ingest.receive(business_id, text.encode(), "email.txt", "email",
                                              email_message_id=msg_id, sender_domain=domain, sender_checks=checks)))
    return created


def send(to: str, subject: str, body: str, reply_to: str | None = None) -> None:
    """Send an approved email (reminders, supplier questions). Demo: delivered to Mailpit."""
    m = EmailMessage()
    m["From"] = _s.bills_inbox_address
    m["To"] = to
    m["Subject"] = subject
    if reply_to:
        m["Reply-To"] = reply_to
    m.set_content(body)
    with smtplib.SMTP(_s.mailpit_smtp_host, _s.mailpit_smtp_port, timeout=10) as smtp:
        smtp.send_message(m)
