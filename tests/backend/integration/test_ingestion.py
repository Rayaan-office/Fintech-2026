"""The document workflow end to end, with a scripted AI."""

from datetime import date, timedelta

from sqlalchemy import select

import app.handlers  # noqa: F401  (registers approval handlers)
from app.ai import gateway
from app.db import tenant_session
from app.demo import documents as demo
from app.models import Action, Document, Extraction
from app.pipeline import ingest
from tests.backend.conftest import acme_form


def _doc(bid, did):
    with tenant_session(bid) as db:
        d = db.get(Document, did)
        db.expunge(d)
        return d


def _bill(number, **kw):
    return demo.acme_bill(number=number, issue=date.today() - timedelta(days=2), **kw)


def test_clean_bill_reaches_approval_and_ai_never_sees_details(businesses, fake_ai):
    bid = businesses["a"]
    bill = _bill("ING-1")
    fake_ai.push(acme_form(bill))
    did = ingest.receive(bid, demo.render(bill), "bill.pdf", "upload")
    d = _doc(bid, did)
    assert d.status == "awaiting_approval"
    assert [s["stage"] for s in d.timeline][-1] == "done"
    sent = fake_ai.calls[0]["sent"]
    for secret in ("41236587", "20-45-77", "accounts@acme-supplies.co.uk", "0113 496 0123", "Jane Smith"):
        assert secret not in sent
    assert "[BANK_ACCOUNT_1]" in sent and "£504.00" in sent
    assert d.fields["payment_bank_account"] == "••••6587"  # shown masked, never in full


def test_wrong_total_is_retried_with_the_problem_explained(businesses, fake_ai):
    bid = businesses["a"]
    bill = _bill("ING-2")
    fake_ai.push(acme_form(bill, total="999.00"), acme_form(bill))
    did = ingest.receive(bid, demo.render(bill), "bill.pdf", "upload")
    assert len(fake_ai.calls) == 2
    assert "does not equal total" in fake_ai.calls[1]["context"]
    assert _doc(bid, did).status == "awaiting_approval"


def test_second_opinion_disagreement_goes_to_a_person(businesses, fake_ai):
    bid = businesses["a"]
    bill = _bill("ING-3")
    bad = acme_form(bill, total="999.00")
    fake_ai.push(bad, bad, acme_form(bill, total="1.00", due_date=""))
    did = ingest.receive(bid, demo.render(bill), "bill.pdf", "upload")
    d = _doc(bid, did)
    assert d.status == "review"
    assert any("disagree" in r for r in d.review_reasons)
    assert len(fake_ai.calls) == 3


def test_second_opinion_agreement_is_accepted(businesses, fake_ai):
    bid = businesses["a"]
    bill = _bill("ING-4")
    bad = acme_form(bill, subtotal="1.00")
    fake_ai.push(bad, bad, acme_form(bill))
    did = ingest.receive(bid, demo.render(bill), "bill.pdf", "upload")
    assert _doc(bid, did).status == "awaiting_approval"
    with tenant_session(bid) as db:
        roles = [e.role for e in db.execute(select(Extraction).where(Extraction.document_id == did)).scalars()]
    assert roles == ["primary", "retry", "second_opinion"]


def test_invented_figures_are_caught(businesses, fake_ai):
    bid = businesses["a"]
    bill = _bill("ING-5")
    invented = acme_form(bill, reference="INV-NOT-THERE")
    fake_ai.push(invented, invented, invented)
    did = ingest.receive(bid, demo.render(bill), "bill.pdf", "upload")
    d = _doc(bid, did)
    assert d.status == "review"


def test_gateway_block_sends_to_a_person(businesses, fake_ai):
    bid = businesses["a"]
    fake_ai.push(gateway.GatewayBlocked("guardrail: prompt injection"))
    did = ingest.receive(bid, demo.render(_bill("ING-6")), "bill.pdf", "upload")
    d = _doc(bid, did)
    assert d.status == "review" and any("hidden instructions" in r for r in d.review_reasons)


def test_fraud_drill_needs_two_people(businesses, fake_ai, sign_in):
    bid = businesses["b"]
    first = _bill("FR-1")
    fake_ai.push(acme_form(first))
    ingest.receive(bid, demo.render(first), "first.pdf", "upload")
    books = sign_in("books@b.test")
    pending = books.get("/api/inbox?tab=needs_approval").json()["items"]
    assert books.post(f"/api/actions/{pending[0]['id']}/approve").status_code == 200

    fraud = demo.acme_fraud_bill()
    fake_ai.push(acme_form(fraud))
    did = ingest.receive(bid, demo.render(fraud), "fraud.pdf", "upload")
    d = _doc(bid, did)
    kinds = {w["kind"] for w in d.warnings}
    assert {"bank_details_changed", "lookalike_sender"} <= kinds
    with tenant_session(bid) as db:
        bank = db.execute(select(Action).where(Action.type == "change_supplier_bank")).scalar_one()
        bill_action = db.execute(select(Action).where(Action.type == "approve_document", Action.status == "pending")).scalar_one()
    # The bookkeeper cannot approve either the bank change or the bill while the change is unconfirmed
    assert books.post(f"/api/actions/{bank.id}/approve").status_code == 403
    assert books.post(f"/api/actions/{bill_action.id}/approve").status_code == 409
    owner, finance = sign_in("owner@b.test"), sign_in("finance@b.test")
    r = owner.post(f"/api/actions/{bank.id}/approve")
    assert r.status_code == 200 and r.json()["status"] == "pending" and len(r.json()["approvals"]) == 1
    assert owner.post(f"/api/actions/{bank.id}/approve").status_code == 409  # same person twice
    assert finance.post(f"/api/actions/{bank.id}/approve").json()["status"] == "executed"
    assert books.post(f"/api/actions/{bill_action.id}/approve").json()["status"] == "executed"


def test_macro_spreadsheet_is_refused(businesses):
    import io
    import zipfile

    import pytest

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/vbaProject.bin", b"macro")
    with pytest.raises(ingest.Rejected):
        ingest.receive(businesses["a"], buf.getvalue(), "sheet.xlsx", "upload")
