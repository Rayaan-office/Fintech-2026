"""The email inbox end to end, through the real Mailpit test inbox in Docker and a scripted AI."""

import smtplib
import time
import uuid
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

import app.handlers  # noqa: F401  (registers approval handlers)
from app import actions
from app.config import get_settings
from app.connectors import email_in, mailpit
from app.db import tenant_session
from app.demo import emails as demo
from app.models import Action, AuditEntry, Counterparty, Document, Notification
from app.privacy.redact import Redacted, mask, store_in_vault, value_fingerprint
from app.seed import create_business
from tests.backend.conftest import PASSWORD, acme_form, people

_s = get_settings()
API = _s.mailpit_api_url.rstrip("/") + "/api/v1"


@pytest.fixture(scope="module", autouse=True)
def _mailpit_running():
    try:
        httpx.get(f"{API}/info", timeout=2).raise_for_status()
    except httpx.HTTPError:
        pytest.skip("Mailpit isn't running: docker compose --env-file .env up -d")


@pytest.fixture(scope="module")
def biz(businesses):
    # A fresh inbox address each run, so emails left in Mailpit by earlier runs never interfere
    inbox = f"bills-{uuid.uuid4().hex[:8]}@c.test"
    b = create_business("Business C", people("c"), {e: PASSWORD for e, *_ in people("c")}, inbox=inbox)
    return SimpleNamespace(id=b.id, inbox=inbox)


def _email(key: str):
    return next(e for e in demo.build() if e.key == key)


def deliver(e: demo.DemoEmail, to: str, envelope: list[str] | None = None) -> str:
    """Send a demo email into Mailpit with a unique Message-ID. Returns Mailpit's ID for it."""
    mid = f"{uuid.uuid4().hex}@test.example"
    e.message.replace_header("Message-ID", f"<{mid}>")
    e.message.replace_header("To", to)
    sender = e.message["From"].addresses[0].addr_spec
    with smtplib.SMTP(_s.mailpit_smtp_host, _s.mailpit_smtp_port, timeout=10) as smtp:
        smtp.sendmail(sender, envelope or [to], demo.to_bytes(e))
    for _ in range(50):
        found = httpx.get(f"{API}/search", params={"query": f'message-id:"{mid}"'}).json()["messages"]
        if found:
            return found[0]["ID"]
        time.sleep(0.1)
    raise AssertionError("email never reached Mailpit")


def _docs(bid) -> list[Document]:
    with tenant_session(bid) as db:
        rows = db.execute(select(Document).order_by(Document.created_at)).scalars().all()
        for r in rows:
            db.expunge(r)
        return rows


def _events(bid, event: str) -> list[AuditEntry]:
    with tenant_session(bid) as db:
        rows = db.execute(select(AuditEntry).where(AuditEntry.event == event)).scalars().all()
        for r in rows:
            db.expunge(r)
        return rows


def _form(e: demo.DemoEmail, **kw) -> dict:
    return acme_form(e.bill, **kw)


# ── Intake ─────────────────────────────────────────────────────────────────


def test_emailed_bill_becomes_a_document_and_the_ai_never_sees_details(biz, fake_ai):
    e = _email("insurance")
    fake_ai.push(_form(e, category_hint="insurance"))
    before = len(_docs(biz.id))
    [outcome] = mailpit.handle_new_message(deliver(e, biz.inbox))
    assert outcome.status == "processed" and len(outcome.documents) == 1
    doc = _docs(biz.id)[before]
    assert doc.source == "email" and doc.filename == "YBI-2026-118.pdf"
    assert doc.sender_domain == "yorkshire-insure.example"
    assert doc.sender_checks["dkim_own"] == "pass" and doc.sender_checks["dmarc"] == "pass"
    sent = fake_ai.calls[0]["sent"]
    s = e.bill.supplier
    for secret in (s.account, s.sort_code, s.email, s.phone, s.contact):
        assert secret not in sent


def test_the_same_email_twice_is_processed_once(biz, fake_ai):
    e = _email("energy")
    fake_ai.push(_form(e))
    mailpit_id = deliver(e, biz.inbox)
    before = len(_docs(biz.id))
    assert mailpit.handle_new_message(mailpit_id)[0].status == "processed"
    assert mailpit.handle_new_message(mailpit_id)[0].status == "duplicate"
    assert len(_docs(biz.id)) == before + 1
    assert _events(biz.id, "email_duplicate_ignored")


def test_resent_copy_with_the_same_message_id_is_a_duplicate(biz, fake_ai):
    e = _email("repairs")
    fake_ai.push(_form(e))
    first = deliver(e, biz.inbox)
    raw = httpx.get(f"{API}/message/{first}/raw").content
    assert email_in.process(biz.id, raw, biz.inbox).status == "processed"
    # Same email delivered again (a new Mailpit message, same Message-ID)
    with smtplib.SMTP(_s.mailpit_smtp_host, _s.mailpit_smtp_port, timeout=10) as smtp:
        smtp.sendmail("jobs@ovendoctors.example", [biz.inbox], raw)
    assert email_in.process(biz.id, raw, biz.inbox).status == "duplicate"


def test_spoofed_sender_is_refused_and_the_owner_is_told(biz, fake_ai):
    before = len(_docs(biz.id))
    [outcome] = mailpit.handle_new_message(deliver(_email("spoof"), biz.inbox))
    assert outcome.status == "refused" and "DMARC" in outcome.reason
    assert len(_docs(biz.id)) == before and not fake_ai.calls
    refused = _events(biz.id, "email_refused")[-1]
    assert refused.details["sender_domain"] == "acme-supplies.co.uk"
    with tenant_session(biz.id) as db:
        titles = [n.title for n in db.execute(select(Notification).where(Notification.kind == "security")).scalars()]
    assert any("acme-supplies.co.uk" in t and "DMARC" in t for t in titles)


def test_text_only_receipt_is_read_and_its_logo_ignored(biz, fake_ai):
    e = _email("receipt")
    receipt = {"doc_type": "receipt", "counterparty_name": "CloudDesk Software Ltd", "issue_date": "",
               "due_date": "", "currency": "GBP", "reference": "", "line_items": [], "subtotal": "", "tax": "",
               "total": "", "payment_bank_account": "", "payment_sort_code": "", "contact_email": "",
               "contact_phone": "", "address": "", "category_hint": "software"}
    fake_ai.push(receipt, receipt, receipt)
    before = len(_docs(biz.id))
    [outcome] = mailpit.handle_new_message(deliver(e, biz.inbox))
    assert outcome.status == "processed" and len(outcome.documents) == 1
    doc = _docs(biz.id)[before]
    assert doc.filename == "email.txt" and doc.mime == "text/plain"
    assert "Total charged" in fake_ai.calls[0]["sent"]


def test_each_attachment_is_a_document_and_unsafe_ones_are_skipped(biz, fake_ai):
    e = _email("acme")
    e.message.add_attachment(demo.documents.render(e.bill), maintype="application", subtype="pdf",
                             filename="copy.pdf")
    e.message.add_attachment(b"MZ\x90\x00 program", maintype="application", subtype="octet-stream",
                             filename="invoice.pdf.exe")
    fake_ai.push(_form(e), _form(e, reference="COPY"), _form(e, reference="COPY"), _form(e, reference="COPY"))
    [outcome] = mailpit.handle_new_message(deliver(e, biz.inbox))
    assert len(outcome.documents) == 2 and len(outcome.skipped) == 1
    assert _events(biz.id, "document_refused")


def test_email_not_sent_to_a_bills_inbox_is_ignored(biz):
    assert mailpit.handle_new_message(deliver(_email("acme"), "someone-else@c.test")) == []


def test_fraud_drill_by_email(biz, fake_ai, sign_in):
    # Acme's genuine bill first, approved, so Acme and its bank details are on record
    real = _email("acme")
    fake_ai.push(_form(real))
    [ok] = mailpit.handle_new_message(deliver(real, biz.inbox))
    books = sign_in("books@c.test")
    with tenant_session(biz.id) as db:
        act = db.execute(select(Action).where(Action.type == "approve_document", Action.status == "pending",
                                              Action.payload["document_id"].astext == ok.documents[0])).scalar_one()
    assert books.post(f"/api/actions/{act.id}/approve").json()["status"] == "executed"

    fraud = _email("fraud")
    fake_ai.push(_form(fraud))
    [outcome] = mailpit.handle_new_message(deliver(fraud, biz.inbox))
    assert outcome.status == "processed"  # its own sender checks pass; the fraud checks catch it
    with tenant_session(biz.id) as db:
        doc = db.get(Document, uuid.UUID(outcome.documents[0]))
        kinds = {w["kind"] for w in doc.warnings}
    assert {"bank_details_changed", "lookalike_sender"} <= kinds


def test_catch_up_finds_emails_that_arrived_while_we_werent_listening(biz, fake_ai, sign_in):
    e = _email("insurance")
    fake_ai.push(_form(e, reference="CATCHUP"), _form(e), _form(e))
    deliver(e, biz.inbox)  # no notification handled
    owner = sign_in("owner@c.test")
    r = owner.post("/api/connections/mailpit/sync")
    assert r.status_code == 200, r.text
    assert r.json()["counts"].get("processed", 0) + r.json()["counts"].get("empty", 0) >= 1
    card = next(c for c in owner.get("/api/connections").json()["items"] if c["kind"] == "email")
    assert card["status"] == "connected" and card["counts"]["emails"] >= 1 and card["address"] == biz.inbox


# ── Notification endpoint ──────────────────────────────────────────────────


def test_notification_runs_intake(biz, fake_ai, client):
    e = _email("repairs")
    fake_ai.push(_form(e))
    before = len(_docs(biz.id))
    r = client.post("/webhooks/mailpit", json={"ID": deliver(e, biz.inbox)})
    assert r.status_code == 200
    assert len(_docs(biz.id)) == before + 1  # background task has run by the time the client returns


def test_notification_from_outside_our_network_is_refused():
    from fastapi.testclient import TestClient

    from app.main import app

    outside = TestClient(app, client=("8.8.8.8", 4000))
    assert outside.post("/webhooks/mailpit", json={"ID": "abc"}).status_code == 403


# ── Sending approved emails ────────────────────────────────────────────────


def _contact(bid, kind: str, name: str, address: str) -> Counterparty:
    with tenant_session(bid) as db:
        cp = Counterparty(business_id=bid, kind=kind, display_name=name, normalized_name=name.lower())
        db.add(cp)
        db.flush()
        cp_id = cp.id
    vid = store_in_vault(bid, Redacted(text="", values={"[EMAIL_1]": ("EMAIL", address)}))["[EMAIL_1]"]
    with tenant_session(bid) as db:
        from app.pipeline import counterparties

        counterparties.add_version(db, bid, cp_id, {"email": {"fp": value_fingerprint("EMAIL", address), "vault": vid,
                                                              "display": mask("EMAIL", address)}}, "test")
        cp = db.get(Counterparty, cp_id)
        db.expunge(cp)
        return cp


def _propose(bid, action_type: str, cp: Counterparty, subject: str, body: str, **extra) -> Action:
    with tenant_session(bid) as db:
        a = actions.propose(db, bid, action_type, requested_by="ai:assistant", summary=subject,
                            payload={"counterparty_id": str(cp.id), "subject": subject, "body": body, **extra})
        db.expunge(a)
        return a


def _received(address: str) -> list[dict]:
    return httpx.get(f"{API}/search", params={"query": f'to:"{address}"'}).json()["messages"]


def test_approved_reminder_is_sent_to_the_address_on_record(biz, sign_in):
    addr = f"accounts-{uuid.uuid4().hex[:6]}@stationcoffee.example"
    cp = _contact(biz.id, "customer", f"Station Coffee {uuid.uuid4().hex[:4]}", addr)
    a = _propose(biz.id, "send_payment_reminder", cp, "Invoice INV-2101 is now due",
                 "Hello,\n\nA friendly reminder that invoice INV-2101 for £1,140.00 is due today.\n\nThanks",
                 to="attacker@evil.example")  # an address in the request is never used
    r = sign_in("books@c.test").post(f"/api/actions/{a.id}/approve")
    assert r.status_code == 200 and r.json()["status"] == "executed", r.text
    [msg] = _received(addr)
    assert not _received("attacker@evil.example")
    full = httpx.get(f"{API}/message/{msg['ID']}").json()
    assert full["From"]["Address"] == biz.inbox and full["From"]["Name"] == "Business C"
    assert "INV-2101" in full["Text"]
    headers = httpx.get(f"{API}/message/{msg['ID']}/headers").json()
    assert headers["Auto-Submitted"] == ["auto-generated"]
    # Our own sent email arriving in Mailpit is not read back in as a bill
    assert mailpit.handle_new_message(msg["ID"]) == []


def test_reminder_to_a_supplier_is_refused(biz, sign_in):
    cp = _contact(biz.id, "supplier", f"Supplier {uuid.uuid4().hex[:4]}", "a@supplier.example")
    a = _propose(biz.id, "send_payment_reminder", cp, "Reminder", "Please pay.")
    assert sign_in("books@c.test").post(f"/api/actions/{a.id}/approve").status_code == 409


def test_we_never_email_a_bills_inbox(biz, sign_in):
    cp = _contact(biz.id, "supplier", f"Loop {uuid.uuid4().hex[:4]}", "bills@a.test")
    a = _propose(biz.id, "email_supplier", cp, "Question about your bill", "Could you confirm the amount?")
    r = sign_in("finance@c.test").post(f"/api/actions/{a.id}/approve")
    assert r.status_code == 409 and "bills inbox" in r.json()["detail"]
    assert not _received("bills@a.test") or all("Question about your bill" != m["Subject"]
                                                  for m in _received("bills@a.test"))


def test_supplier_without_an_address_on_record_cannot_be_emailed(biz, sign_in):
    with tenant_session(biz.id) as db:
        cp = Counterparty(business_id=biz.id, kind="supplier", display_name="No Email Ltd",
                          normalized_name=f"no email {uuid.uuid4().hex[:4]}")
        db.add(cp)
        db.flush()
        db.expunge(cp)
    a = _propose(biz.id, "email_supplier", cp, "Question", "Could you confirm the amount?")
    r = sign_in("finance@c.test").post(f"/api/actions/{a.id}/approve")
    assert r.status_code == 409 and "No Email Ltd" in r.json()["detail"]


def test_employees_cannot_approve_outgoing_emails(biz, sign_in):
    cp = _contact(biz.id, "customer", f"Cafe {uuid.uuid4().hex[:4]}", "x@cafe.example")
    a = _propose(biz.id, "send_payment_reminder", cp, "Reminder", "Please pay.")
    assert sign_in("staff@c.test").post(f"/api/actions/{a.id}/approve").status_code == 403
