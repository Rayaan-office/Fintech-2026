"""Sending emails a person has approved: payment reminders and questions to suppliers.

Demo: delivered to the Mailpit test inbox over SMTP. Production: the business's own mail provider.
The recipient always comes from the details on record, never from the AI or a document,
and the approver sees exactly the text that is sent.
"""

import re
import smtplib
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from ..config import get_settings
from ..db import global_session
from ..privacy.detectors import PLACEHOLDER_RE
from .common import lookup_route

_s = get_settings()
_ADDR = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
MAX_BODY = 20_000


class SendRefused(Exception):
    pass


def check(to: str, subject: str, body: str) -> None:
    if not _ADDR.match(to or ""):
        raise SendRefused("That isn't a valid email address.")
    if not subject.strip() or any(c in subject for c in "\r\n") or len(subject) > 200:
        raise SendRefused("The subject must be one line of up to 200 characters.")
    if not body.strip() or len(body) > MAX_BODY:
        raise SendRefused("The message is empty or too long.")
    if PLACEHOLDER_RE.search(subject + body):
        raise SendRefused("The message still contains a hidden-detail placeholder.")
    with global_session() as db:
        if lookup_route(db, "email", to.lower()):
            raise SendRefused("We never send to a bills inbox.")  # it would come straight back in


def send(to: str, subject: str, body: str, *, from_address: str, from_name: str) -> str:
    """Send one plain-text email. Returns its Message-ID."""
    check(to, subject, body)
    m = EmailMessage()
    m["From"] = formataddr((from_name, from_address))
    m["To"] = to
    m["Subject"] = subject.strip()
    m["Date"] = formatdate(localtime=False)
    m["Message-ID"] = make_msgid(domain=from_address.rsplit("@", 1)[-1])
    m["Auto-Submitted"] = "auto-generated"  # stops out-of-office replies bouncing back and forth
    m.set_content(body)
    with smtplib.SMTP(_s.mailpit_smtp_host, _s.mailpit_smtp_port, timeout=10) as smtp:
        smtp.send_message(m)
    return m["Message-ID"]
