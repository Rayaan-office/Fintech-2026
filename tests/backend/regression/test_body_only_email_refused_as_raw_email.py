"""Emails with no attachment (card receipts, payment notices) were always refused.

We turned the email's text into a document starting with "Subject: ...". The file check
identifies files by content, saw a mail header and called it a raw email (message/rfc822),
which isn't an accepted type.
"""

from email.message import EmailMessage

from app.connectors import email_in
from app.pipeline.files import inspect


def test_email_text_document_passes_the_file_check():
    m = EmailMessage()
    m["From"] = "billing@clouddesk.io"
    m["Subject"] = "Receipt for your payment CD-7706"
    m.set_content("Receipt CD-7706\r\nCloudDesk Business plan, monthly\r\nTotal charged: £94.80")
    text = email_in.body_document(m)
    assert text.startswith("Email subject: Receipt")
    assert inspect(text.encode(), "email.txt").mime == "text/plain"


def test_short_email_text_is_not_a_document():
    m = EmailMessage()
    m.set_content("Thanks!")
    assert email_in.body_document(m) is None
