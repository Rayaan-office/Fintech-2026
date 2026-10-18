"""Ask: the chat assistant. Each person sees only their own conversations."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..copilot import assistant, insights
from ..models import ChatMessage, ChatThread, Counterparty
from ..security.http import limiter
from ..security.rbac import Perm
from .advice import propose_email
from .deps import Principal, require, tenant_db
from .inbox import action_out

router = APIRouter(prefix="/api", tags=["assistant"])


class AskIn(BaseModel):
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    thread_id: UUID | None = None


def _meta(m: ChatMessage) -> dict:
    return next((b for b in m.blocks or [] if b.get("type") == "meta"), {})


def _message_out(m: ChatMessage) -> dict:
    meta = _meta(m)
    out = {"id": str(m.id), "role": m.role, "created_at": m.created_at.isoformat()}
    if m.role == "user":
        return out | {"text": m.content}
    return out | {"answer": {"text": m.content, "redacted_input": "", "ai_written": meta.get("ai_written", False)},
                  "blocks": [b for b in m.blocks or [] if b.get("type") != "meta"],
                  "sources": meta.get("sources", []), "follow_ups": meta.get("follow_ups", []),
                  "suggestion": meta.get("suggestion"), "checked": m.checked}


@router.post("/ask")
def ask(body: AskIn, p: Principal = Depends(require(Perm.USE_ASSISTANT))):
    limiter.check(f"ask:{p.user_id}", 20, 600)
    try:
        out = assistant.ask(p.business_id, p.user_id, p.perms, body.question, thread_id=body.thread_id)
    except LookupError:
        raise HTTPException(404, "Not found.")
    return {"id": out["id"], "thread_id": out["thread_id"],
            "answer": {"text": out["text"], "redacted_input": out["redacted_input"], "ai_written": out["ai_written"]},
            "blocks": out["blocks"], "sources": out["sources"], "follow_ups": out["follow_ups"],
            "suggestion": out["suggestion"], "confirmation": None}


@router.get("/ask/threads")
def threads(p: Principal = Depends(require(Perm.USE_ASSISTANT)), db: Session = Depends(tenant_db)):
    rows = db.execute(select(ChatThread).where(ChatThread.user_id == p.user_id)
                      .order_by(ChatThread.created_at.desc()).limit(50)).scalars()
    return {"items": [{"id": str(t.id), "title": t.title, "created_at": t.created_at.isoformat()} for t in rows]}


@router.get("/ask/stats")
def stats(p: Principal = Depends(require(Perm.USE_ASSISTANT)), db: Session = Depends(tenant_db)):
    """Your own questions: how many we answered from your records, and how many passed the fact check first time."""
    return assistant.stats(db, p.user_id)


@router.get("/ask/threads/{thread_id}")
def thread(thread_id: UUID, p: Principal = Depends(require(Perm.USE_ASSISTANT)), db: Session = Depends(tenant_db)):
    t = db.get(ChatThread, thread_id)
    if not t or t.user_id != p.user_id:
        raise HTTPException(404, "Not found.")
    msgs = db.execute(select(ChatMessage).where(ChatMessage.thread_id == t.id)
                      .order_by(ChatMessage.created_at)).scalars()
    return {"id": str(t.id), "title": t.title, "messages": [_message_out(m) for m in msgs]}


@router.post("/ask/messages/{message_id}/act")
def act(message_id: UUID, p: Principal = Depends(require(Perm.SEND_REMINDER)), db: Session = Depends(tenant_db)):
    """Draft the email the assistant suggested. It waits in the inbox for approval."""
    m = db.get(ChatMessage, message_id)
    t = db.get(ChatThread, m.thread_id) if m else None
    if not m or not t or t.user_id != p.user_id or m.role != "assistant":
        raise HTTPException(404, "Not found.")
    s = _meta(m).get("suggestion")
    if not s:
        raise HTTPException(409, "This answer has no suggested next step.")
    cp = db.get(Counterparty, UUID(s["counterparty_id"]))
    if not cp:
        raise HTTPException(404, "Not found.")
    limiter.check(f"draft:{p.user_id}", 20, 600)
    if s["type"] == "send_payment_reminder":
        facts, body = insights.reminder_facts(db, cp)
        purpose = "a friendly reminder about the overdue invoices, asking when they will be paid"
    else:
        facts, body = {"what we noticed": m.content[:800]}, (
            "We have a question about your recent bills. Could you get in touch, please?")
        purpose = "a polite question about their recent bills, based on what we noticed"
    d = insights.draft(db, p.business_id, s["type"], cp, purpose, facts, body)
    return {"action": action_out(db, propose_email(db, p, s["type"], d), p)}
