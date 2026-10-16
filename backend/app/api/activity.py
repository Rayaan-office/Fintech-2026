"""Activity log, live updates, notifications and the Pause AI switch."""

import asyncio
import csv
import io

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from .. import events
from ..models import AuditEntry, Business, Notification
from ..security import audit
from ..security.http import csv_safe
from ..security.rbac import Perm
from .deps import Principal, current_principal, page_params, require, tenant_db

router = APIRouter(prefix="/api", tags=["activity"])


@router.get("/activity")
def activity(event: str | None = None, actor: str | None = None, page=Depends(page_params),
             p: Principal = Depends(require(Perm.VIEW_ACTIVITY)), db: Session = Depends(tenant_db)):
    limit, offset = page
    q = select(AuditEntry).order_by(AuditEntry.seq.desc())
    if event:
        q = q.where(AuditEntry.event == event)
    if actor:
        q = q.where(AuditEntry.actor.startswith(actor))
    rows = db.execute(q.limit(limit).offset(offset)).scalars().all()
    total = db.execute(select(func.count()).select_from(AuditEntry)).scalar()
    return {"items": [{"seq": e.seq, "at": e.at.isoformat(), "actor": e.actor, "event": e.event, "subject": e.subject,
                       "details": e.details, "hash": e.hash[:12]} for e in rows], "total": total}


@router.get("/activity/verify")
def verify(p: Principal = Depends(require(Perm.VIEW_ACTIVITY)), db: Session = Depends(tenant_db)):
    return audit.verify_chain(db, p.business_id)


@router.get("/activity/export.csv")
def export(p: Principal = Depends(require(Perm.VIEW_ACTIVITY)), db: Session = Depends(tenant_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["seq", "time", "actor", "event", "subject", "fingerprint"])
    for e in db.execute(select(AuditEntry).order_by(AuditEntry.seq)).scalars():
        w.writerow([e.seq, e.at.isoformat(), csv_safe(e.actor), csv_safe(e.event), csv_safe(e.subject), e.hash])
    audit.record(db, p.business_id, p.actor, "activity_exported")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=activity.csv"})


@router.get("/events")
async def stream(request: Request, p: Principal = Depends(current_principal)):
    q = events.subscribe(p.business_id)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                    yield {"event": "update", "data": item}
                except TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            events.unsubscribe(p.business_id, q)

    return EventSourceResponse(gen())


@router.get("/notifications")
def notifications(p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    rows = db.execute(select(Notification).where((Notification.user_id.is_(None)) | (Notification.user_id == p.user_id))
                      .order_by(Notification.created_at.desc()).limit(30)).scalars().all()
    return {"items": [{"id": str(n.id), "kind": n.kind, "title": n.title, "link": n.link, "read": n.read,
                       "created_at": n.created_at.isoformat()} for n in rows]}


@router.post("/notifications/read")
def mark_read(p: Principal = Depends(current_principal), db: Session = Depends(tenant_db)):
    for n in db.execute(select(Notification).where(Notification.read.is_(False))).scalars():
        n.read = True
    return {"ok": True}


class PauseIn(BaseModel):
    paused: bool


@router.post("/settings/ai-pause")
def pause_ai(body: PauseIn, p: Principal = Depends(require(Perm.PAUSE_AI)), db: Session = Depends(tenant_db)):
    """Stop (or restart) every automatic AI action at once."""
    b = db.get(Business, p.business_id)
    b.ai_paused = body.paused
    audit.record(db, b.id, p.actor, "ai_paused" if body.paused else "ai_resumed")
    events.publish(b.id, "ai_pause", {"paused": body.paused})
    return {"ai_paused": b.ai_paused}
