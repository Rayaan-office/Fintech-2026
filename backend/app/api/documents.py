"""Documents: upload, list, the review view (original beside extracted values), corrections."""

import json
import re
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import actions, archive
from ..models import Action, Correction, Counterparty, Document, Extraction
from ..pipeline import ingest
from ..pipeline.extract import amount_variants, date_variants, to_date, to_minor
from ..security import audit
from ..security.crypto import layout as layout_box
from ..security.http import limiter
from ..security.rbac import Perm
from .deps import Principal, current_principal, page_params, require, tenant_db

router = APIRouter(prefix="/api/documents", tags=["documents"])

STAGE_LABELS = {
    "received": "Received", "safety_check": "Safety check", "archived": "Locked archive", "reading": "Reading the text",
    "hiding_details": "Hiding personal details", "privacy_check": "Final privacy check", "ai_form": "AI fills in the form",
    "checks": "Do the numbers add up?", "retry": "Trying again", "second_opinion": "Second opinion",
    "matching": "Matching", "done": "Done",
}
EDITABLE = {"counterparty_name", "issue_date", "due_date", "currency", "reference", "subtotal", "tax", "total",
            "category_hint", "doc_type"}


def _visible(p: Principal, d: Document) -> bool:
    return p.can(Perm.VIEW_ALL) or (p.can(Perm.VIEW_OWN_SUBMISSIONS) and d.submitted_by == p.user_id)


def doc_summary(d: Document, cp_name: str | None = None) -> dict:
    f = d.fields or {}
    return {
        "id": str(d.id), "filename": d.filename, "source": d.source, "status": d.status, "stage": d.stage,
        "stage_label": STAGE_LABELS.get(d.stage, d.stage), "doc_type": d.doc_type,
        "counterparty": cp_name or f.get("counterparty_name"), "total_minor": to_minor(f.get("total")),
        "currency": f.get("currency") or "GBP", "due_date": f.get("due_date") or None,
        "warnings": [{"kind": w["kind"], "label": w["label"]} for w in (d.warnings or [])],
        "created_at": d.created_at.isoformat(),
    }


@router.post("")
async def upload(file: UploadFile = File(...), source: str = Form("upload"),
                 p: Principal = Depends(require(Perm.SUBMIT_RECEIPT))):
    limiter.check(f"upload:{p.user_id}", 30, 300)
    if source not in ("upload", "photo", "statement"):
        source = "upload"
    data = await file.read(ingest_max() + 1)
    try:
        did = ingest.receive(p.business_id, data, file.filename or "upload", source, submitted_by=p.user_id,
                             actor=p.actor)
    except ingest.Rejected as e:
        raise HTTPException(400, e.message)
    return {"id": str(did)}


def ingest_max() -> int:
    from ..config import get_settings

    return get_settings().upload_max_bytes


@router.get("")
def list_documents(status: str | None = None, page=Depends(page_params), p: Principal = Depends(current_principal),
                   db: Session = Depends(tenant_db)):
    if not (p.can(Perm.VIEW_ALL) or p.can(Perm.VIEW_OWN_SUBMISSIONS)):
        raise HTTPException(403, "Your role does not allow this.")
    limit, offset = page
    q = select(Document).order_by(Document.created_at.desc())
    if not p.can(Perm.VIEW_ALL):
        q = q.where(Document.submitted_by == p.user_id)
    if status:
        q = q.where(Document.status == status)
    docs = db.execute(q.limit(limit).offset(offset)).scalars().all()
    names = {c.id: c.display_name for c in db.execute(select(Counterparty).where(
        Counterparty.id.in_({d.counterparty_id for d in docs if d.counterparty_id}))).scalars()}
    return {"items": [doc_summary(d, names.get(d.counterparty_id)) for d in docs]}


def _get(db, p, document_id) -> Document:
    d = db.get(Document, document_id)
    if not d or not _visible(p, d):
        raise HTTPException(404, "Not found.")  # same answer whether it doesn't exist or isn't yours
    return d


def _highlights(d: Document) -> list[dict]:
    """Where each extracted value sits on the original page, for the side-by-side view."""
    if not d.layout_enc or not d.fields:
        return []
    words = json.loads(layout_box.open_str(d.layout_enc))
    norm = [re.sub(r"[£$€,\s]", "", w["text"]).lower() for w in words]
    out = []
    f = d.fields
    targets = {}
    for name in ("total", "subtotal", "tax"):
        m = to_minor(f.get(name))
        if m:
            targets[name] = {v.replace(",", "").lstrip("£") for v in amount_variants(m)}
    for name in ("issue_date", "due_date"):
        dt = to_date(f.get(name))
        if dt:
            targets[name] = {v.replace(",", "") for v in date_variants(dt)}
    if f.get("reference"):
        targets["reference"] = {f["reference"].lower().replace(" ", "")}
    for name, variants in targets.items():
        for i, w in enumerate(norm):
            if w in variants:
                ww = words[i]
                out.append({"field": name, "page": ww["page"], "box": [ww["x0"], ww["y0"], ww["x1"], ww["y1"]]})
    return out


@router.get("/{document_id}")
def get_document(document_id: UUID, p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    d = _get(db, p, document_id)
    cp = db.get(Counterparty, d.counterparty_id) if d.counterparty_id else None
    exts = db.execute(select(Extraction).where(Extraction.document_id == d.id).order_by(Extraction.attempt)).scalars()
    pending = db.execute(select(Action).where(Action.payload["document_id"].astext == str(d.id))
                         .order_by(Action.created_at)).scalars().all()
    from .inbox import action_out

    return {
        **doc_summary(d, cp.display_name if cp else None),
        "fields": d.fields, "timeline": [{**s, "label": STAGE_LABELS.get(s["stage"], s["stage"])} for s in d.timeline],
        "review_reasons": d.review_reasons, "warnings": d.warnings, "pages": d.pages, "mime": d.mime,
        "sha256": d.sha256, "sender_domain": d.sender_domain, "sender_checks": d.sender_checks,
        "ai_saw": d.redacted_text, "highlights": _highlights(d),
        "attempts": [{"attempt": e.attempt, "role": e.role, "model": e.model, "passed": e.passed,
                      "problems": e.checks.get("problems", []), "provider": e.checks.get("provider")} for e in exts],
        "actions": [action_out(db, a, p) for a in pending],
        "record_id": str(d.record_id) if d.record_id else None,
        "learned": {k: {"value": v.get("value"), "ai_value": v.get("ai_value"), "corrections": v.get("corrections"),
                        "learned_as": v.get("learned_as"), "undone": bool(v.get("undone"))}
                    for k, v in (d.learned or {}).items()},
    }


@router.get("/{document_id}/original")
def original(document_id: UUID, p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    d = _get(db, p, document_id)
    try:
        data = archive.get(d.object_key, d.sha256)
    except archive.ArchiveTampered:
        audit.record(db, d.business_id, "system", "archive_tampered", subject=f"document:{d.id}")
        raise HTTPException(409, "The stored original no longer matches its fingerprint.")
    audit.record(db, d.business_id, p.actor, "original_viewed", subject=f"document:{d.id}")
    return Response(data, media_type=d.mime, headers={
        "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; "
        "img-src data: blob:; object-src 'none'; frame-ancestors 'self'", "X-Frame-Options": "SAMEORIGIN"})


class FieldEdit(BaseModel):
    fields: dict[str, str] = Field(max_length=20)


@router.post("/{document_id}/fields")
def correct(document_id: UUID, body: FieldEdit, p: Principal = Depends(require(Perm.REVIEW_DOCUMENTS)),
            db: Session = Depends(tenant_db)):
    """A person corrects the extracted values. The AI's original answer is kept beside each correction,
    even when a field is corrected more than once."""
    d = _get(db, p, document_id)
    if d.status in ("approved", "rejected"):
        raise HTTPException(409, "This document has already been decided.")
    bad = set(body.fields) - EDITABLE
    if bad:
        raise HTTPException(422, "These fields can't be edited: " + ", ".join(sorted(bad)))
    fields = dict(d.fields or {})
    learned = {k: dict(v) for k, v in (d.learned or {}).items()}
    ai_first = {}  # the AI's own answer for fields already corrected on this document
    for c in db.execute(select(Correction).where(Correction.document_id == d.id)
                        .order_by(Correction.created_at.desc())).scalars():
        ai_first[c.field] = c.ai_value
    changed = []
    for k, v in body.fields.items():
        v = v.strip()[:300]
        if k in ("subtotal", "tax", "total") and v and to_minor(v) is None:
            raise HTTPException(422, f"{k} must be an amount like 120.50.")
        if k in ("issue_date", "due_date") and v and not to_date(v):
            raise HTTPException(422, f"{k} must be a date like 2026-10-30.")
        if v == str(fields.get(k) or ""):
            continue
        ai = ai_first[k] if k in ai_first else learned[k]["ai_value"] if k in learned else str(fields.get(k) or "")
        changed.append((k, ai, v))
        if k in learned:
            learned[k]["undone"] = v != learned[k]["value"]  # a filled-in value the person changed
        fields[k] = v
    d.fields = fields
    d.learned = learned
    audit.record(db, d.business_id, p.actor, "fields_corrected", subject=f"document:{d.id}",
                 details={"fields": sorted(body.fields)})
    if d.status == "review":
        # A person has checked it: raise the normal approval
        from ..pipeline.counterparties import find_or_create

        kind = "customer" if fields.get("doc_type") == "invoice" else "supplier"
        cp, _ = find_or_create(db, d.business_id, kind, fields.get("counterparty_name") or "Unknown")
        d.counterparty_id = cp.id if cp else None
        d.doc_type = fields.get("doc_type") or d.doc_type or "bill"
        total = to_minor(fields.get("total"))
        actions.propose(db, d.business_id, "approve_document", requested_by=p.actor,
                        payload={"document_id": str(d.id), "counterparty_id": str(cp.id) if cp else None, "details": {}},
                        summary=f"Record {d.doc_type}: £{(total or 0) / 100:,.2f} from {fields.get('counterparty_name')}",
                        effects=[f"Add a {d.doc_type} to the ledger"], amount_minor=total,
                        reasons=["Checked and corrected by a person."])
        d.status = "awaiting_approval"
    elif d.status == "awaiting_approval" and changed:
        _refresh_approval(db, p, d, fields)
    for k, ai, v in changed:
        db.add(Correction(business_id=d.business_id, document_id=d.id, field=k, ai_value=ai, human_value=v,
                          user_id=p.user_id, counterparty_id=d.counterparty_id))
    # Earlier corrections follow the document to its corrected supplier
    db.execute(update(Correction).where(Correction.document_id == d.id)
               .values(counterparty_id=d.counterparty_id))
    db.flush()
    return get_document(document_id, p, db)


def _refresh_approval(db: Session, p: Principal, d: Document, fields: dict) -> None:
    """Values changed while the document waits for approval. The waiting approval is replaced, so the
    approver sees the corrected supplier and amount and the bill is recorded against the right supplier.
    A bank-detail check is never dropped: it moves to the corrected supplier and still needs two people."""
    from ..pipeline.counterparties import compare, find_or_create, latest_details

    waiting = db.execute(select(Action).where(Action.type == "approve_document", Action.status == "pending",
                                              Action.payload["document_id"].astext == str(d.id))).scalars().all()
    if not waiting:
        return
    old = waiting[0]
    kind = "customer" if fields.get("doc_type") == "invoice" else "supplier"
    cp, is_new = find_or_create(db, d.business_id, kind, fields.get("counterparty_name") or "Unknown")
    d.counterparty_id = cp.id if cp else None
    d.doc_type = fields.get("doc_type") or d.doc_type or "bill"
    payload = dict(old.payload)
    reasons = [r for r in old.reasons if r != CORRECTED]
    if payload.get("counterparty_id") != (str(cp.id) if cp else None):
        payload["counterparty_id"] = str(cp.id) if cp else None
        details = payload.get("details") or {}
        bank = db.get(Action, UUID(payload["bank_change_action_id"])) if payload.get("bank_change_action_id") else None
        moved = bank is not None and bank.status == "pending"
        if moved:
            _cancel(db, p, bank, "The supplier was corrected, so the bank-detail check moved to the right one.")
        changed_bank = cp is not None and any(c["bank"] for c in compare(latest_details(db, cp.id), details))
        if cp and (moved or changed_bank):
            bank = actions.propose(
                db, d.business_id, "change_supplier_bank", requested_by=p.actor,
                payload={"counterparty_id": str(cp.id), "document_id": str(d.id), "details": details},
                summary=f"Confirm new bank details for {cp.display_name}",
                effects=[f"{k.replace('_', ' ')}: {v.get('display')}" for k, v in details.items()
                         if k in ("bank_account", "sort_code")],
                reasons=["Bank details changed: confirm with the supplier using the contact details already on record."])
            payload["bank_change_action_id"] = str(bank.id)
        elif bank is None or bank.status != "executed":
            payload["bank_change_action_id"] = None
        if is_new:
            reasons.append(f"This is a new {kind}.")
    for a in waiting:
        _cancel(db, p, a, "Replaced by the corrected version.")
    total = to_minor(fields.get("total"))
    currency = (fields.get("currency") or "GBP").upper()
    amount = f"£{(total or 0) / 100:,.2f}" if currency == "GBP" else f"{fields.get('total')} {currency}"
    actions.propose(db, d.business_id, "approve_document", requested_by=p.actor, payload=payload,
                    summary=f"Record {d.doc_type.replace('_', ' ')}: {amount} from {fields.get('counterparty_name')}"
                            + (f", due {fields['due_date']}" if fields.get("due_date") else ""),
                    effects=[f"Add a {d.doc_type.replace('_', ' ')} of {amount} to the ledger",
                             "Match it to payments and bank records"],
                    amount_minor=total, reasons=[*reasons, CORRECTED])


CORRECTED = "Corrected by a person while it waited for approval."


def _cancel(db: Session, p: Principal, a: Action, why: str) -> None:
    a.status = "cancelled"
    a.decided_at = datetime.now(UTC)
    a.result = {"reason": why}
    audit.record(db, a.business_id, p.actor, "action_cancelled", subject=f"action:{a.id}",
                 details={"type": a.type, "reason": "document_corrected"})


@router.post("/{document_id}/reprocess")
def reprocess(document_id: UUID, p: Principal = Depends(require(Perm.REVIEW_DOCUMENTS)), db: Session = Depends(tenant_db)):
    d = _get(db, p, document_id)
    if d.status not in ("review",):
        raise HTTPException(409, "Only documents waiting for review can be processed again.")
    d.status = "queued"
    audit.record(db, d.business_id, p.actor, "document_reprocessed", subject=f"document:{d.id}")
    db.flush()
    ingest.enqueue(d.business_id, d.id)
    return {"ok": True}
