"""Phone handoff: a QR code on the computer opens an upload page on the phone, which can send a few
photos for ten minutes. The link is the only key, so it is long, random, short-lived, limited to a
few uploads and stored only as a fingerprint. Photos go through the same safety checks as any upload."""

import base64
import hashlib
import secrets
import socket
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import tenant_session
from ..models import Business, Document, HandoffToken
from ..pipeline import ingest
from ..security import audit
from ..security.http import limiter
from ..security.rbac import Perm
from .deps import Principal, require, tenant_db

router = APIRouter(prefix="/api/handoff", tags=["handoff"])

TTL = timedelta(minutes=10)
MAX_UPLOADS = 10
GONE = "This link has expired or been used up. Scan a new code on your computer."


def _fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _token(business_id: UUID, secret: str) -> str:
    # The business is named in the link so the phone's request can open that business's rows; the
    # random part is what proves it
    return f"{base64.urlsafe_b64encode(business_id.bytes).decode().rstrip('=')}.{secret}"


def _parse(token: str) -> tuple[UUID, str]:
    try:
        head, secret = token.split(".", 1)
        bid = UUID(bytes=base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)))
    except ValueError:
        raise HTTPException(404, GONE)
    if len(secret) < 40:
        raise HTTPException(404, GONE)
    return bid, secret


def _lan_address() -> str | None:
    """This computer's address on the local network. Connecting a UDP socket sends nothing."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def phone_base_url() -> str:
    """Where a phone can open the app. A phone can't reach "localhost", so in development we use
    this computer's address on the Wi-Fi (the phone must be on the same network)."""
    s = get_settings()
    if s.handoff_base_url:
        return s.handoff_base_url.rstrip("/")
    parts = urlsplit(s.app_base_url)
    if s.is_dev and parts.hostname in ("localhost", "127.0.0.1") and (ip := _lan_address()):
        return urlunsplit(parts._replace(netloc=f"{ip}:{parts.port}" if parts.port else ip)).rstrip("/")
    return s.app_base_url.rstrip("/")


@router.post("")
def create(p: Principal = Depends(require(Perm.SUBMIT_RECEIPT)), db: Session = Depends(tenant_db)):
    limiter.check(f"handoff:{p.user_id}", 10, 600)
    secret = secrets.token_urlsafe(32)
    t = HandoffToken(business_id=p.business_id, user_id=p.user_id, token_hash=_fingerprint(secret),
                     expires_at=datetime.now(UTC) + TTL)
    db.add(t)
    db.flush()
    audit.record(db, p.business_id, p.actor, "handoff_created", subject=f"handoff:{t.id}",
                 details={"minutes": int(TTL.total_seconds() // 60), "max_uploads": MAX_UPLOADS})
    return {"id": str(t.id), "url": f"{phone_base_url()}/m/{_token(p.business_id, secret)}",
            "expires_at": t.expires_at.isoformat(), "max_uploads": MAX_UPLOADS}


@router.get("/{handoff_id}")
def status(handoff_id: UUID, p: Principal = Depends(require(Perm.SUBMIT_RECEIPT)), db: Session = Depends(tenant_db)):
    """The computer watches what has arrived from the phone."""
    t = db.get(HandoffToken, handoff_id)
    if not t or t.user_id != p.user_id:
        raise HTTPException(404, "Not found.")
    docs = db.execute(select(Document).where(Document.submitted_by == p.user_id, Document.source == "photo",
                                             Document.created_at >= t.created_at)
                      .order_by(Document.created_at).limit(MAX_UPLOADS)).scalars().all()
    return {"id": str(t.id), "expires_at": t.expires_at.isoformat(), "expired": t.expires_at <= datetime.now(UTC),
            "received": [{"id": str(d.id), "filename": d.filename, "status": d.status} for d in docs]}


def _live(db: Session, secret: str) -> HandoffToken:
    t = db.execute(select(HandoffToken).where(HandoffToken.token_hash == _fingerprint(secret))
                   .with_for_update()).scalar_one_or_none()
    if not t or t.expires_at <= datetime.now(UTC) or t.used_count >= MAX_UPLOADS:
        raise HTTPException(404, GONE)
    return t


@router.get("/upload/{token}")
def phone_page(token: str):
    """What the phone's page shows before a photo: whose it is, and how long the link lasts."""
    bid, secret = _parse(token)
    limiter.check(f"handoff-open:{secret[:16]}", 60, 600)
    with tenant_session(bid) as db:
        t = _live(db, secret)
        return {"business": db.get(Business, bid).name, "expires_at": t.expires_at.isoformat(),
                "left": MAX_UPLOADS - t.used_count}


@router.post("/upload/{token}")
async def phone_upload(token: str, file: UploadFile = File(...)):
    bid, secret = _parse(token)
    limiter.check(f"handoff-up:{secret[:16]}", MAX_UPLOADS * 2, 600)
    data = await file.read(get_settings().upload_max_bytes + 1)
    with tenant_session(bid) as db:
        t = _live(db, secret)
        t.used_count += 1
        user_id, left = t.user_id, MAX_UPLOADS - t.used_count
    try:
        did = ingest.receive(bid, data, file.filename or "photo.jpg", "photo", submitted_by=user_id,
                             actor=f"user:{user_id}")
    except ingest.Rejected as e:
        raise HTTPException(400, e.message)
    return {"id": str(did), "left": left}
