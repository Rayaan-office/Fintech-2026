"""One incoming email becomes documents, whichever inbox it came from.

The Mailpit test inbox uses this now; an IMAP mailbox would use it in production.

    process(business_id, raw, inbox) -> Outcome

1. Skip it if we have seen its Message-ID before.
2. Refuse what we never process: mail loops, automatic replies and delivery reports, email that
   fails the sender checks, oversized email, and floods.
3. Send each attachment (or the text of the email, if there is none) through the document workflow.

Sender checks: we trust only the Authentication-Results header added by our own receiving
server (it names itself first; the sender can write any other such header). We also check the
DKIM signature ourselves.
"""

import email
import email.policy
import hashlib
import logging
import re
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import parseaddr
from html.parser import HTMLParser

from fastapi import HTTPException

from ..config import get_settings
from ..db import tenant_session
from ..models import Notification
from ..security import audit
from ..security.http import limiter
from .common import get_connection, mark_synced, seen_before

_s = get_settings()
log = logging.getLogger("copilot.email")

MAX_FILES = 10
MAX_PARTS = 60
MIN_BODY_CHARS = 40
LOGO_MAX_BYTES = 200_000
_RESULT = re.compile(r"\b(spf|dkim|dmarc)\s*=\s*([a-z]+)", re.I)
FAILED = {"fail", "softfail", "permerror"}


@dataclass
class Outcome:
    status: str  # processed | empty | duplicate | refused
    documents: list[str] = field(default_factory=list)
    reason: str | None = None
    skipped: list[str] = field(default_factory=list)  # attachments the safety check refused


# ── Sender checks ──────────────────────────────────────────────────────────


def trusted_results(msg: EmailMessage) -> dict:
    """SPF, DKIM and DMARC as judged by our own receiving server, or {} if it left no verdict."""
    ours = _s.mail_authserv_id.lower()
    for header in msg.get_all("Authentication-Results") or []:
        value = str(header)
        head, _, rest = value.partition(";")
        if (head.split() or [""])[0].lower() != ours:
            continue  # written by someone else, so it could say anything
        out: dict[str, str] = {}
        for k, v in _RESULT.findall(rest):
            out.setdefault(k.lower(), v.lower())
        return out  # topmost one only
    return {}


def _dkim_key(name: bytes, timeout: int = 5) -> bytes | None:
    if _s.app_env == "production":
        import dkim.dnsplug

        return dkim.dnsplug.get_txt(name, timeout=timeout)
    from ..demo import mailkeys

    return mailkeys.txt_record(name)  # no DNS lookups outside production


def dkim_check(raw: bytes, from_domain: str | None) -> dict:
    """Our own check of the sender's signature.

    result: pass | fail (key found, signature wrong) | temperror (no key to check against) | none (unsigned).
    aligned: the signature belongs to the sender's own domain.
    """
    if not re.search(rb"^DKIM-Signature:", raw, re.I | re.M):
        return {"result": "none", "domain": None, "aligned": False}
    import dkim

    found = {"key": False}

    def lookup(name, timeout=5):
        txt = _dkim_key(name, timeout)
        found["key"] = found["key"] or bool(txt)
        return txt

    d = dkim.DKIM(raw, logger=log, timeout=5)
    try:
        ok = bool(d.verify(dnsfunc=lookup))
    except Exception:
        ok = False
    domain = d.domain.decode().lower() if getattr(d, "domain", None) else None
    result = "pass" if ok else ("fail" if found["key"] else "temperror")
    aligned = bool(domain and from_domain and (from_domain == domain or from_domain.endswith("." + domain)))
    return {"result": result, "domain": domain, "aligned": aligned}


def sender_checks(raw: bytes, msg: EmailMessage, from_domain: str | None) -> dict:
    trusted = trusted_results(msg)
    own = dkim_check(raw, from_domain)
    dkim_result = own["result"] if own["result"] in ("pass", "fail") else trusted.get("dkim", "none")
    return {
        "spf": trusted.get("spf", "none"), "dkim": dkim_result, "dmarc": trusted.get("dmarc", "none"),
        "receiver_verdict": bool(trusted), "dkim_own": own["result"], "dkim_domain": own["domain"],
        "dkim_aligned": own["aligned"],
    }


def refusal_reason(msg: EmailMessage, sender: str, checks: dict, inbox: str) -> str | None:
    """Why we won't process this email at all, or None."""
    if not sender or "@" not in sender:
        return "it has no sender address"
    if sender == inbox.lower():
        return "it was sent from the bills inbox itself"
    if (str(msg.get("Auto-Submitted") or "no").strip().lower() != "no"
            or str(msg.get("Precedence") or "").strip().lower() == "auto_reply" or msg.get("X-Autoreply")):
        return "it is an automatic reply"
    if msg.get_content_type() == "multipart/report":
        return "it is a delivery report"
    if checks.get("dmarc") in FAILED:
        return "the sender's domain says this email is not genuine (DMARC failed)"
    if checks.get("dkim_own") == "fail" and checks.get("dkim_aligned"):
        return "the sender's signature doesn't match, so it was forged or changed on the way"
    return None


# ── Content ────────────────────────────────────────────────────────────────


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    lines = (" ".join(line.split()) for line in "".join(p.out).splitlines())
    return "\n".join(line for line in lines if line)


def body_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except Exception:
        return ""
    if part.get_content_type() == "text/html":
        content = html_to_text(content)
    return content.strip()[:20_000]


def body_document(msg: EmailMessage) -> str | None:
    """The email's text as a document, for emails with nothing attached (e.g. card receipts).
    It must not start with "Subject:", or the file check takes it for a raw email and refuses it."""
    body = body_text(msg).replace("\r\n", "\n")
    if len(body) < MIN_BODY_CHARS:
        return None
    subject = " ".join(str(msg.get("Subject") or "").split())[:200]
    return f"Email subject: {subject}\n\n{body}"


def safe_filename(name: str | None) -> str:
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*').strip(" .")
    return name[:200] or "attachment"


def attachments(msg: EmailMessage) -> list[tuple[str, bytes]]:
    """Files attached to the email, including those inside a forwarded email.
    Logos and signature images shown in the email's own text are left out."""
    html = msg.get_body(preferencelist=("html",))
    html_text = ""
    if html is not None:
        try:
            html_text = html.get_content()
        except Exception:
            pass
    out: list[tuple[str, bytes]] = []
    for n, part in enumerate(msg.walk()):
        if n > MAX_PARTS:
            break
        if part.is_multipart() or part.get_content_type() == "message/rfc822":
            continue
        ctype = part.get_content_type()
        disposition = part.get_content_disposition()
        if ctype in ("text/plain", "text/html") and disposition != "attachment":
            continue  # the email's own text
        data = part.get_payload(decode=True) or b""
        if not data:
            continue
        cid = str(part.get("Content-ID") or "").strip("<> ")
        if cid and f"cid:{cid}" in html_text and ctype.startswith("image/") and len(data) < LOGO_MAX_BYTES:
            continue
        out.append((safe_filename(part.get_filename() or f"attachment.{ctype.split('/')[-1]}"), data))
    return out


def message_key(msg: EmailMessage, raw: bytes) -> str:
    mid = str(msg.get("Message-ID") or "").strip().strip("<>").strip()
    return mid[:400] if mid else "sha256:" + hashlib.sha256(raw).hexdigest()


# ── Processing ─────────────────────────────────────────────────────────────


def _tally(db, business_id, **inc) -> None:
    c = get_connection(db, business_id, "mailpit")
    totals = dict((c.meta or {}).get("totals") or {})
    for k, v in inc.items():
        totals[k] = totals.get(k, 0) + v
    c.meta = {**(c.meta or {}), "totals": totals}
    mark_synced(db, c, totals)


def _refuse(business_id, key: str, domain: str | None, reason: str) -> Outcome:
    with tenant_session(business_id) as db:
        audit.record(db, business_id, "system", "email_refused",
                     details={"message_id": key[:200], "sender_domain": domain, "reason": reason})
        who = f" from {domain}" if domain else ""
        db.add(Notification(business_id=business_id, kind="security",
                            title=f"We didn't process an email{who}: {reason}.", link="/activity"))
        _tally(db, business_id, emails=1, refused=1)
    return Outcome("refused", reason=reason)


def process(business_id, raw: bytes, inbox: str) -> Outcome:
    from ..pipeline import ingest

    msg = email.message_from_bytes(raw, policy=email.policy.default)
    key = message_key(msg, raw)
    sender = parseaddr(str(msg.get("From") or ""))[1].strip().lower()
    domain = sender.rsplit("@", 1)[-1] if "@" in sender else None

    with tenant_session(business_id) as db:
        if seen_before(db, business_id, "email", key):
            audit.record(db, business_id, "system", "email_duplicate_ignored", details={"message_id": key[:200]})
            _tally(db, business_id, duplicates=1)
            return Outcome("duplicate")

    if len(raw) > _s.email_max_bytes:
        return _refuse(business_id, key, domain, f"it is larger than {_s.email_max_bytes // (1024 * 1024)} MB")
    try:
        limiter.check(f"email:{business_id}", _s.emails_per_business_per_hour, 3600)
    except HTTPException:
        return _refuse(business_id, key, domain, "too many emails arrived this hour")
    checks = sender_checks(raw, msg, domain)
    reason = refusal_reason(msg, sender, checks, inbox)
    if reason:
        return _refuse(business_id, key, domain, reason)

    files = attachments(msg)
    created, skipped = [], []
    for name, data in files[:MAX_FILES]:
        try:
            created.append(str(ingest.receive(business_id, data, name, "email", email_message_id=key,
                                              sender_domain=domain, sender_checks=checks)))
        except ingest.Rejected as e:
            skipped.append(e.message)
    if not files:
        text = body_document(msg)
        if text:
            try:
                created.append(str(ingest.receive(business_id, text.encode(), "email.txt", "email",
                                                  email_message_id=key, sender_domain=domain, sender_checks=checks)))
            except ingest.Rejected as e:
                skipped.append(e.message)
    with tenant_session(business_id) as db:
        audit.record(db, business_id, "system", "email_received", details={
            "message_id": key[:200], "sender_domain": domain, "documents": len(created),
            "attachments_refused": len(skipped), "extra_attachments_ignored": max(0, len(files) - MAX_FILES),
            "spf": checks["spf"], "dkim": checks["dkim"], "dmarc": checks["dmarc"],
        })
        _tally(db, business_id, emails=1, documents=len(created))
    return Outcome("processed" if created else "empty", created, skipped=skipped)
