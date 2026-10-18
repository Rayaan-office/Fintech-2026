"""Document intake and the ingestion workflow (LangGraph).

    receive()  safety check -> locked archive -> queued
    workflow   read text -> hide personal details -> final privacy check -> AI fills the form
               -> checks -> (retry once) -> (second opinion) -> supplier, fraud checks -> proposal

Each step is written to the document's timeline and pushed live to the browser.
Anything uncertain stops and goes to a person.
"""

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any, TypedDict
from uuid import UUID

from langgraph.graph import END, StateGraph
from sqlalchemy import select

from .. import actions, archive, events
from ..ai import gateway
from ..copilot import learning
from ..db import global_session, tenant_session
from ..models import Business, Connection, Document, Extraction
from ..privacy.redact import PrivacyBlock, Redacted, final_scan, mask, redact, restore, store_in_vault, \
    value_fingerprint, vault_values
from ..security import audit
from ..security.crypto import layout as layout_box
from . import counterparties, extract, fraud, reader
from .files import UnsafeFile, inspect

log = logging.getLogger("copilot.ingest")

STAGES = ["received", "safety_check", "archived", "reading", "hiding_details", "privacy_check", "ai_form",
          "checks", "retry", "second_opinion", "matching", "done"]


class Rejected(Exception):
    def __init__(self, message: str, existing_id: UUID | None = None):
        super().__init__(message)
        self.message = message
        self.existing_id = existing_id


# ── Intake ─────────────────────────────────────────────────────────────────


def receive(business_id, data: bytes, filename: str, source: str, *, submitted_by=None,
            email_message_id: str | None = None, sender_domain: str | None = None,
            sender_checks: dict | None = None, actor: str = "system") -> UUID:
    """Safety check and archive. Returns the new document's ID; processing continues in the background."""
    try:
        info = inspect(data, filename)
    except UnsafeFile as e:
        with tenant_session(business_id) as db:
            audit.record(db, business_id, actor, "document_refused", details={"reason": e.message, "source": source})
        raise Rejected(e.message)
    key, digest = archive.put(business_id, data)
    now = datetime.now(UTC).isoformat()
    with tenant_session(business_id) as db:
        doc = Document(
            business_id=business_id, source=source, status="queued", stage="archived",
            filename=filename[:300], mime=info.mime, size_bytes=info.size, sha256=digest, object_key=key,
            email_message_id=email_message_id, sender_domain=sender_domain, sender_checks=sender_checks or {},
            submitted_by=submitted_by,
            timeline=[{"stage": "received", "at": now, "ok": True},
                      {"stage": "safety_check", "at": now, "ok": True, "note": f"{info.family}, {info.size} bytes"},
                      {"stage": "archived", "at": now, "ok": True, "note": f"fingerprint {digest[:12]}…"}],
        )
        db.add(doc)
        db.flush()
        audit.record(db, business_id, actor, "document_received", subject=f"document:{doc.id}",
                     details={"source": source, "sha256": digest, "mime": info.mime, "size": info.size})
        doc_id = doc.id
    events.publish(business_id, "document", {"id": str(doc_id), "stage": "archived", "status": "queued"})
    enqueue(business_id, doc_id)
    return doc_id


# ── Workflow state and helpers ─────────────────────────────────────────────


class State(TypedDict, total=False):
    business_id: str
    document_id: str
    family: str
    text: str
    redacted: Any  # Redacted
    attempt: int
    form: Any  # DocumentForm
    checks: dict
    problems: list[str]
    second_form: Any
    outcome: str  # accepted | review | failed
    review_reasons: list[str]


def _step(state: State, stage: str, ok: bool = True, note: str | None = None, status: str | None = None) -> None:
    bid, did = state["business_id"], state["document_id"]
    with tenant_session(bid) as db:
        doc = db.get(Document, UUID(did))
        doc.stage = stage
        doc.timeline = [*doc.timeline, {"stage": stage, "at": datetime.now(UTC).isoformat(), "ok": ok,
                                        **({"note": note} if note else {})}]
        if status:
            doc.status = status
    events.publish(bid, "document", {"id": did, "stage": stage, "ok": ok, "status": status, "note": note})


def _to_review(state: State, reason: str, stage: str) -> State:
    _step(state, stage, ok=False, note=reason)
    return {**state, "outcome": "review", "review_reasons": [*state.get("review_reasons", []), reason]}


# ── Nodes ──────────────────────────────────────────────────────────────────


def read_text(state: State) -> State:
    bid, did = state["business_id"], UUID(state["document_id"])
    with tenant_session(bid) as db:
        doc = db.get(Document, did)
        key, sha, mime, name = doc.object_key, doc.sha256, doc.mime, doc.filename
        doc.status = "processing"
    _step(state, "reading")
    data = archive.get(key, sha)
    family = inspect(data, name).family
    try:
        result = reader.read_document(data, family)
    except reader.TooManyPages as e:
        return _to_review(state, f"The document has {e.args[0]} pages, more than we read automatically.", "reading")
    except TimeoutError:
        return _to_review(state, "Reading the document took too long.", "reading")
    if len(result.text.strip()) < 15:
        return _to_review(state, "We couldn't read any text. The photo may be blurred or too dark.", "reading")
    with tenant_session(bid) as db:
        doc = db.get(Document, did)
        doc.pages = result.pages
        doc.layout_enc = layout_box.seal_str(
            __import__("json").dumps([asdict(w) for w in result.words[:20000]]))
    _step(state, "reading", note=f"{result.pages} page(s), {result.method.replace('_', ' ')}")
    return {**state, "family": family, "text": result.text}


def hide_details(state: State) -> State:
    _step(state, "hiding_details")
    r = redact(state["text"])
    mapping = store_in_vault(state["business_id"], r)
    with tenant_session(state["business_id"]) as db:
        doc = db.get(Document, UUID(state["document_id"]))
        doc.redacted_text = r.text
        doc.placeholder_map = mapping
        audit.record(db, doc.business_id, "system", "details_hidden", subject=f"document:{doc.id}",
                     details={"hidden": r.summary()})
    hidden = sum(r.counts.values())
    _step(state, "hiding_details", note=f"{hidden} detail(s) replaced with placeholders")
    return {**state, "redacted": r, "text": ""}  # drop the raw text from memory as soon as possible


def privacy_check(state: State) -> State:
    try:
        final_scan(state["redacted"].text)
    except PrivacyBlock as e:
        return _to_review(state, "A personal detail may still be in the text, so nothing was sent to the AI ("
                          + ", ".join(e.kinds) + ").", "privacy_check")
    _step(state, "privacy_check", note="Nothing personal left")
    return state


def _ai_read(state: State, model: str, role: str, problems: list[str] | None = None) -> State:
    stage = {"primary": "ai_form", "retry": "retry", "second_opinion": "second_opinion"}[role]
    _step(state, stage)
    context = ""
    if problems:
        context = "Your previous answer had these problems. Fix them and fill in the form again:\n- " + "\n- ".join(problems)
    try:
        res = gateway.complete_json(state["business_id"], f"extract_{role}", extract.INSTRUCTIONS,
                                    state["redacted"].text, extract.DocumentForm, model=model, context=context)
    except PrivacyBlock as e:
        return _to_review(state, "A personal detail was found at the last moment, so nothing was sent.", stage)
    except gateway.GatewayBlocked:
        with tenant_session(state["business_id"]) as db:
            audit.record(db, UUID(state["business_id"]), "system", "gateway_block", subject=f"document:{state['document_id']}")
        return _to_review(state, "Possible hidden instructions or a sensitive detail: the AI gateway blocked it.", stage)
    except gateway.AIError as e:
        return _to_review(state, f"The AI step could not finish ({e.reason.replace('_', ' ')}).", stage)
    placeholders = set(state["redacted"].values)
    checks = extract.check(res.data, state["redacted"].text, placeholders)
    attempt = state.get("attempt", 0) + 1
    with tenant_session(state["business_id"]) as db:
        db.add(Extraction(business_id=UUID(state["business_id"]), document_id=UUID(state["document_id"]),
                          attempt=attempt, role=role, model=res.model, fields=res.data.model_dump(),
                          checks={**checks, "provider": res.provider, "prompt": extract.PROMPT_VERSION},
                          passed=checks["passed"]))
        audit.record(db, UUID(state["business_id"]), f"ai:{role}", "ai_form_filled",
                     subject=f"document:{state['document_id']}",
                     details={"model": res.model, "passed": checks["passed"], "problems": len(checks["problems"])})
    if res.gateway_labels:
        checks["problems"].append("The AI gateway replaced a detail in the answer.")
        checks["passed"] = False
    _step(state, "checks", ok=checks["passed"],
          note="All checks passed" if checks["passed"] else f"{len(checks['problems'])} problem(s) found")
    key = "second_form" if role == "second_opinion" else "form"
    return {**state, key: res.data, "checks": checks, "problems": checks["problems"], "attempt": attempt}


def ai_form(state: State) -> State:
    return _ai_read(state, gateway._s.ai_model_primary, "primary")


def retry(state: State) -> State:
    return _ai_read(state, gateway._s.ai_model_primary, "retry", state.get("problems"))


def second_opinion(state: State) -> State:
    first = state["form"]
    out = _ai_read(state, gateway._s.ai_model_second_opinion, "second_opinion")
    if out.get("outcome") == "review":
        return out
    same, diffs = extract.agree(first, out["second_form"])
    if not same:
        return _to_review(out, "Two independent readings disagree on: " + ", ".join(diffs).replace("_", " ") + ".",
                          "second_opinion")
    if not out["checks"]["passed"]:
        return _to_review(out, "Both readings agree, but: " + " ".join(out["problems"][:3]), "second_opinion")
    _step(out, "second_opinion", note="Both readings agree")
    return {**out, "form": out["second_form"], "outcome": "accepted"}


def decide_after_checks(state: State) -> str:
    if state.get("outcome") == "review":
        return "finish"
    if state["checks"]["passed"]:
        return "propose"
    return "retry" if state.get("attempt", 0) < 2 else "second_opinion"


def after_second(state: State) -> str:
    return "finish" if state.get("outcome") == "review" else "propose"


def propose(state: State) -> State:
    """Restore hidden values, find the supplier, run fraud checks and raise the approval."""
    bid, did = UUID(state["business_id"]), UUID(state["document_id"])
    form: extract.DocumentForm = state["form"]
    r: Redacted = state["redacted"]
    _step(state, "matching")
    with tenant_session(bid) as db:
        doc = db.get(Document, did)
        ph_to_vid = doc.placeholder_map or {}
        real = vault_values(bid, list(ph_to_vid.values()))
        ph_to_real = {ph: real.get(vid, ph) for ph, vid in ph_to_vid.items()}
        fields = restore(form.model_dump(), ph_to_real)
        # Values learned from past corrections, from our own records: nothing extra goes to the AI
        filled = learning.fill(db, fields)

        kind = "customer" if fields["doc_type"] == "invoice" else "supplier"
        cp, is_new = counterparties.find_or_create(db, bid, kind, fields["counterparty_name"], doc.sender_domain)

        # Details on this document, as fingerprints and masked display values
        new_details = {}
        for f, kind_label in counterparties.TRACKED.items():
            ph_value = {"bank_account": form.payment_bank_account, "sort_code": form.payment_sort_code,
                        "email": form.contact_email, "phone": form.contact_phone, "address": form.address}[f]
            real_value = fields[{"bank_account": "payment_bank_account", "sort_code": "payment_sort_code",
                                 "email": "contact_email", "phone": "contact_phone", "address": "address"}[f]]
            if real_value:
                new_details[f] = {"fp": value_fingerprint(kind_label, real_value),
                                  "vault": ph_to_vid.get(ph_value.strip(), None),
                                  "display": mask(kind_label, real_value)}
        changes = counterparties.compare(counterparties.latest_details(db, cp.id), new_details) if cp else []
        total = extract.to_minor(form.total)
        contact_domain = fields["contact_email"].split("@")[-1].lower() if "@" in fields["contact_email"] else None
        warnings = fraud.check(db, document=doc, counterparty=cp, is_new_counterparty=is_new,
                               reference=form.reference, total_minor=total, changes=changes, redacted_text=r.text,
                               contact_domain=contact_domain)
        if cp and is_new and not cp.email_domain and contact_domain:
            cp.email_domain = contact_domain
        # Public view of the form: hidden values shown masked, never in full
        display = dict(fields)
        for f, label in (("payment_bank_account", "BANK_ACCOUNT"), ("payment_sort_code", "SORT_CODE"),
                         ("contact_email", "EMAIL"), ("contact_phone", "PHONE")):
            if display.get(f):
                display[f] = mask(label, display[f])
        doc.fields = display
        doc.learned = filled
        doc.doc_type = fields["doc_type"]
        doc.counterparty_id = cp.id if cp else None
        doc.warnings = warnings
        reasons = [w["label"] + ": " + w["detail"] for w in warnings]
        if is_new:
            reasons.append("This is a new " + kind + ".")
        if state.get("attempt", 1) > 1:
            reasons.append("The AI needed more than one attempt.")
        check = learning.needs_check(filled)
        if check:
            reasons.append("Filled from your past corrections, please check: " + ", ".join(check) + ".")

        bank_action = None
        if any(w["kind"] == "bank_details_changed" for w in warnings) and cp:
            bank_action = actions.propose(
                db, bid, "change_supplier_bank", requested_by="ai:ingestion",
                payload={"counterparty_id": str(cp.id), "document_id": str(did), "details": new_details},
                summary=f"Confirm new bank details for {cp.display_name}",
                effects=[f"{c['field'].replace('_', ' ')}: {c['before']} → {c['after']}" for c in changes if c["bank"]],
                reasons=["Bank details changed: confirm with the supplier using the contact details already on record."],
            )
        verb = {"bill": "Record bill", "invoice": "Record invoice", "receipt": "Record receipt",
                "credit_note": "Record credit note"}.get(fields["doc_type"], "File document")
        currency = (fields["currency"] or "").upper()
        amount_txt = f"£{(total or 0) / 100:,.2f}" if currency == "GBP" else f"{form.total} {currency}"
        action = actions.propose(
            db, bid, "approve_document", requested_by="ai:ingestion",
            payload={"document_id": str(did), "counterparty_id": str(cp.id) if cp else None,
                     "details": new_details, "bank_change_action_id": str(bank_action.id) if bank_action else None},
            summary=f"{verb}: {amount_txt} from {fields['counterparty_name']}"
                    + (f", due {fields['due_date']}" if fields["due_date"] else ""),
            effects=[f"Add a {fields['doc_type'].replace('_', ' ')} of {amount_txt} to the ledger",
                     "Match it to payments and bank records"],
            amount_minor=total, reasons=reasons,
            auto_ok=not is_new and not warnings and state.get("attempt", 1) == 1,
        )
        doc.status = "approved" if action.status == "executed" else "awaiting_approval"
        doc.review_reasons = reasons
        status = doc.status
    note = "Recorded automatically" if status == "approved" else "Waiting for approval"
    if filled:
        note += f"; {len(filled)} value(s) filled from your past corrections"
    _step(state, "done", note=note, status=status)
    return {**state, "outcome": "accepted"}


def finish(state: State) -> State:
    with tenant_session(UUID(state["business_id"])) as db:
        doc = db.get(Document, UUID(state["document_id"]))
        doc.status = "review"
        doc.review_reasons = state.get("review_reasons", [])
        audit.record(db, doc.business_id, "system", "document_needs_person", subject=f"document:{doc.id}",
                     details={"reasons": len(doc.review_reasons)})
    events.publish(state["business_id"], "document", {"id": state["document_id"], "status": "review"})
    return state


def _build():
    g = StateGraph(State)
    for name, fn in [("read_text", read_text), ("hide_details", hide_details), ("privacy_check", privacy_check),
                     ("ai_form", ai_form), ("retry", retry), ("second_opinion", second_opinion),
                     ("propose", propose), ("finish", finish)]:
        g.add_node(name, fn)
    g.set_entry_point("read_text")
    stop_or = lambda nxt: (lambda s: "finish" if s.get("outcome") == "review" else nxt)  # noqa: E731
    g.add_conditional_edges("read_text", stop_or("hide_details"), ["finish", "hide_details"])
    g.add_edge("hide_details", "privacy_check")
    g.add_conditional_edges("privacy_check", stop_or("ai_form"), ["finish", "ai_form"])
    g.add_conditional_edges("ai_form", decide_after_checks, ["finish", "propose", "retry", "second_opinion"])
    g.add_conditional_edges("retry", decide_after_checks, ["finish", "propose", "retry", "second_opinion"])
    g.add_conditional_edges("second_opinion", after_second, ["finish", "propose"])
    g.add_edge("propose", END)
    g.add_edge("finish", END)
    return g.compile()


graph = _build()

# ── Work queue ─────────────────────────────────────────────────────────────

_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="ingest")
_inflight: set[str] = set()
_inflight_lock = threading.Lock()
SYNC_FOR_TESTS = False


def process(business_id, document_id) -> None:
    key = str(document_id)
    try:
        graph.invoke({"business_id": str(business_id), "document_id": key, "attempt": 0})
    except Exception as exc:
        log.exception("ingestion failed: %s", type(exc).__name__)
        with tenant_session(business_id) as db:
            doc = db.get(Document, UUID(key))
            if doc:
                doc.status = "review"
                doc.review_reasons = [*(doc.review_reasons or []), "Processing stopped unexpectedly; please check it."]
                audit.record(db, business_id, "system", "document_failed", subject=f"document:{key}",
                             details={"error": type(exc).__name__})
        events.publish(business_id, "document", {"id": key, "status": "review"})
    finally:
        with _inflight_lock:
            _inflight.discard(key)


def enqueue(business_id, document_id) -> None:
    key = str(document_id)
    with _inflight_lock:
        if key in _inflight:
            return
        _inflight.add(key)
    if SYNC_FOR_TESTS:
        process(business_id, document_id)
    else:
        _pool.submit(process, business_id, document_id)


def resume_unfinished() -> int:
    """After a restart, pick up documents that were queued or half-processed."""
    n = 0
    with global_session() as db:
        bids = db.execute(select(Business.id)).scalars().all()
    for bid in bids:
        with tenant_session(bid) as db:
            ids = db.execute(select(Document.id).where(Document.status.in_(("queued", "processing")))).scalars().all()
        for did in ids:
            enqueue(bid, did)
            n += 1
    return n


def accounting_connected(db, business_id) -> bool:
    c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one_or_none()
    return bool(c and c.status == "connected")
