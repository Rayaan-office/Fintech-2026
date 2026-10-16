"""The demo's emailed bills and receipts, sent into the Mailpit test inbox.

    uv run python -m app.demo.emails                # all of them
    uv run python -m app.demo.emails fraud spoof    # just these

The amounts come from the same story as the bank feed and the accounting company, so
they match later. Message-IDs are fixed, so sending twice shows duplicates being ignored.

Each email is signed (DKIM) with its domain's demo key, as a real mail provider would do.
Mailpit doesn't add Authentication-Results, so we add the verdict our receiving server would
give (named after it, see MAIL_AUTHSERV_ID). The spoofed email also carries a forged verdict
under another server's name, which our app ignores.
"""

import smtplib
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, time
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime, formataddr

import dkim

from ..config import get_settings
from . import documents, mailkeys, story

_s = get_settings()
SIGNED_HEADERS = [b"from", b"to", b"subject", b"date", b"message-id"]
# A 1×1 PNG used as the "logo" in the receipt email; it should not become a document
LOGO = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                     "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


@dataclass
class DemoEmail:
    key: str
    description: str
    message: EmailMessage
    sign_as: str | None  # domain whose demo key signs it, or None for unsigned
    verdict: str | None  # what our receiving server would say, e.g. "spf=pass dkim=pass dmarc=pass"
    forged_verdict: str | None = None
    bill: documents.Bill | None = None  # what the attached bill says, for tests


def _base(sender: tuple[str, str], to: str, subject: str, when, message_id: str) -> EmailMessage:
    m = EmailMessage()
    m["From"] = formataddr(sender)
    m["To"] = to
    m["Subject"] = subject
    m["Date"] = format_datetime(datetime.combine(when, time(9, 30), tzinfo=UTC))
    m["Message-ID"] = f"<{message_id}>"
    return m


def _bill_email(key, desc, supplier: documents.Supplier, bill: documents.Bill, to, body, sign=True,
                verdict="spf=pass dkim=pass dmarc=pass") -> DemoEmail:
    domain = supplier.email.split("@")[1]
    m = _base((f"{supplier.name} Accounts", supplier.email), to, f"Invoice {bill.number} from {supplier.name}",
              bill.issue, f"{bill.number.lower()}@{domain}")
    m.set_content(body)
    m.add_attachment(documents.render(bill), maintype="application", subtype="pdf", filename=f"{bill.number}.pdf")
    return DemoEmail(key, desc, m, domain if sign else None, f"{verdict} header.from={domain}", bill=bill)


def _from_story(b: story.Bill) -> documents.Bill:
    return documents.Bill(documents.BY_KEY[b.supplier_key], b.number, b.issue, b.due, b.lines)


def build(to: str | None = None) -> list[DemoEmail]:
    to = to or _s.bills_inbox_address
    s = story.build()
    latest = {}
    for b in s.bills:
        latest.setdefault(b.supplier_key, [])
        latest[b.supplier_key].append(b)
    acme = next(b for b in reversed(latest["acme"]) if not b.paid_on)
    energy = latest["energy"][-1]
    software = latest["software"][-1]
    insurance = next(b for b in latest["insurance"] if b.number == "YBI-2026-118")
    repairs = next(b for b in latest["repairs"] if b.number == "OD-4471")
    out = [
        _bill_email("acme", "Acme Supplies' weekly stock bill (flour price up 18%)", documents.ACME,
                    _from_story(acme), to,
                    f"Hi,\n\nPlease find attached invoice {acme.number}. Payment is due within 30 days.\n\n"
                    "Kind regards,\nJane\nAcme Supplies Ltd"),
        _bill_email("energy", "BrightSpark's monthly energy bill", documents.BRIGHTSPARK, _from_story(energy), to,
                    f"Your energy bill {energy.number} is attached. It will be collected by Direct Debit "
                    "on the due date.\n\nBrightSpark Energy"),
        _bill_email("insurance", "Annual insurance renewal", documents.INSURANCE, _from_story(insurance), to,
                    f"Dear customer,\n\nYour annual business insurance renewal ({insurance.number}) is attached.\n\n"
                    "Yorkshire Business Insurance"),
        # A small firm without email signing: no warning, just no signature to check
        _bill_email("repairs", "Oven repair bill (unsigned email, small firm)", documents.OVEN_DOCTORS,
                    _from_story(repairs), to,
                    f"Hi, invoice {repairs.number} for the deck oven repair is attached. Thanks, Chris",
                    sign=False, verdict="spf=pass dkim=none dmarc=none"),
    ]

    # Card receipt with no attachment: the email's text is the document
    soft_total = software.total / 100
    receipt = _base(("CloudDesk Billing", documents.CLOUDDESK.email), to, f"Receipt for your payment {software.number}",
                    software.issue, f"{software.number.lower()}@clouddesk.io")
    receipt.set_content(f"Receipt {software.number}\nCloudDesk Business plan, monthly\nTotal charged: £{soft_total:,.2f}")
    receipt.add_alternative(
        '<html><body><img src="cid:logo@clouddesk.io" alt="CloudDesk"><h2>Payment receipt</h2>'
        f"<p>Receipt number: {software.number}<br>Date: {software.issue:%d %B %Y}</p>"
        f"<table><tr><td>CloudDesk Business plan (monthly)</td><td>£{software.subtotal / 100:,.2f}</td></tr>"
        f"<tr><td>VAT (20%)</td><td>£{(software.total - software.subtotal) / 100:,.2f}</td></tr>"
        f"<tr><td><b>Total charged to your card</b></td><td><b>£{soft_total:,.2f}</b></td></tr></table>"
        "<p>CloudDesk Software Ltd, 5 Silicon Way, London</p></body></html>", subtype="html")
    receipt.get_payload()[1].add_related(LOGO, maintype="image", subtype="png", cid="<logo@clouddesk.io>")
    out.append(DemoEmail("receipt", "CloudDesk card receipt (no attachment, text only)", receipt, "clouddesk.io",
                         "spf=pass dkim=pass dmarc=pass header.from=clouddesk.io"))

    # Fraud drill: a look-alike domain the fraudster really controls, so its own checks pass
    fraud = documents.acme_fraud_bill()
    fake = documents.ACME_NEW_BANK
    m = _base(("Acme Supplies Accounts", fake.email), to, f"URGENT: invoice {fraud.number} - new bank details",
              fraud.issue, f"{fraud.number.lower()}@acme-suppl1es.co.uk")
    m.set_content("Hi,\n\nWe have moved banks. Please pay the attached invoice to our NEW account today "
                  "to avoid a late fee. Do not use the old details.\n\nJane")
    m.add_attachment(documents.render(fraud), maintype="application", subtype="pdf", filename=f"{fraud.number}.pdf")
    out.append(DemoEmail("fraud", "Fraud drill: look-alike Acme domain, changed bank details", m,
                         "acme-suppl1es.co.uk", "spf=pass dkim=pass dmarc=pass header.from=acme-suppl1es.co.uk",
                         bill=fraud))

    # Spoofed sender: claims to be Acme's real address but isn't signed by Acme
    spoof_bill = documents.Bill(documents.ACME_NEW_BANK, "INV-1052", fraud.issue, fraud.due, fraud.lines,
                                note=fraud.note)
    m = _base(("Acme Supplies Accounts", documents.ACME.email), to, f"Invoice {spoof_bill.number}", fraud.issue,
              "inv-1052@acme-supplies.co.uk")
    m.set_content("Please pay the attached invoice to our new account.")
    m.add_attachment(documents.render(spoof_bill), maintype="application", subtype="pdf",
                     filename=f"{spoof_bill.number}.pdf")
    out.append(DemoEmail("spoof", "Spoofed sender: pretends to be acme-supplies.co.uk (refused)", m, None,
                         "spf=fail smtp.mailfrom=acme-supplies.co.uk; dkim=none; dmarc=fail header.from=acme-supplies.co.uk",
                         forged_verdict="mx.google.com; spf=pass; dkim=pass; dmarc=pass", bill=spoof_bill))
    return out


def to_bytes(e: DemoEmail) -> bytes:
    """The email as our receiving server would hand it on: signed, with its verdict on top."""
    raw = e.message.as_bytes(policy=SMTP)
    if e.sign_as:
        raw = dkim.sign(raw, mailkeys.SELECTOR.encode(), e.sign_as.encode(), mailkeys.private_key(e.sign_as),
                        include_headers=SIGNED_HEADERS) + raw
    if e.forged_verdict:
        raw = f"Authentication-Results: {e.forged_verdict}\r\n".encode() + raw
    if e.verdict:
        raw = f"Authentication-Results: {_s.mail_authserv_id}; {e.verdict}\r\n".encode() + raw
    return raw


def send(e: DemoEmail, to: str | None = None) -> None:
    to = to or _s.bills_inbox_address
    sender = e.message["From"].addresses[0].addr_spec
    with smtplib.SMTP(_s.mailpit_smtp_host, _s.mailpit_smtp_port, timeout=10) as smtp:
        smtp.sendmail(sender, [to], to_bytes(e))


def main(keys: list[str]) -> None:
    emails = build()
    unknown = set(keys) - {e.key for e in emails}
    if unknown:
        sys.exit(f"unknown email(s): {', '.join(sorted(unknown))}. Choose from: {', '.join(e.key for e in emails)}")
    for e in emails:
        if not keys or e.key in keys:
            send(e)
            print(f"sent {e.key:<10} {e.description}")


if __name__ == "__main__":
    main(sys.argv[1:])
