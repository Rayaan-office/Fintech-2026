"""Sign-in, two-step codes and sign-out."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..config import get_settings
from ..db import global_session, tenant_session
from ..models import AuthSession, Business, LoginAttempt, Membership, Notification, User
from ..security import audit
from ..security.crypto import new_token, token_hash
from ..security.http import client_ip, limiter
from ..security.passwords import needs_rehash, hash_password, new_totp_secret, totp_uri, verify_password, verify_totp
from ..security.rbac import LEVEL_LABELS, TOTP_REQUIRED_ROLES
from .deps import SESSION_COOKIE, Principal, current_principal, current_principal_partial

router = APIRouter(prefix="/api/auth", tags=["auth"])
_s = get_settings()

MAX_FAILURES = 5
LOCK_MINUTES = 15


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=1, max_length=200)


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=8, pattern=r"^\d+$")


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", secure=_s.app_base_url.startswith("https:"),
        max_age=_s.session_absolute_hours * 3600, path="/",
    )


def _needs_totp(roles: list[str], second_approver: bool) -> bool:
    return bool(set(roles) & TOTP_REQUIRED_ROLES) or second_approver


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = client_ip(request)
    limiter.check(f"login-ip:{ip}", 20, 60)
    email = body.email.lower()
    ehash = token_hash(email)
    now = datetime.now(UTC)
    # Record the failure in its own transaction so it is kept when we refuse the sign-in
    with global_session() as db:
        user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        locked = bool(user and user.locked_until and user.locked_until > now)
        ok = verify_password(user.password_hash if user else None, body.password) and not locked
        db.add(LoginAttempt(email_hash=ehash, ip=ip, success=ok))
        if not ok and user and not locked:
            user.failed_logins += 1
            if user.failed_logins >= MAX_FAILURES:
                user.locked_until = now + timedelta(minutes=LOCK_MINUTES)
                _alert_owners(db, user, "Several failed sign-in attempts; the account is locked for 15 minutes.")
    if not ok:
        raise HTTPException(401, "Email or password is incorrect.")
    with global_session() as db:
        user = db.execute(select(User).where(User.email == email)).scalar_one()
        user.failed_logins = 0
        user.locked_until = None
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(body.password)
        m = db.execute(select(Membership).where(Membership.user_id == user.id)).scalars().first()
        if not m:
            raise HTTPException(403, "This account is not part of a business.")
        token = new_token()
        db.add(AuthSession(token_hash=token_hash(token), user_id=user.id, business_id=m.business_id))
        needs = _needs_totp(m.roles, m.second_approver)
        result = {
            "totp_required": needs and user.totp_enabled,
            "totp_setup_required": needs and not user.totp_enabled,
        }
        bid, uid = m.business_id, user.id
    with tenant_session(bid) as tdb:
        audit.record(tdb, bid, f"user:{uid}", "signed_in", details={"ip": ip, "two_step_pending": needs})
    _set_cookie(response, token)
    return result


def _alert_owners(db, user: User, message: str) -> None:
    m = db.execute(select(Membership).where(Membership.user_id == user.id)).scalars().first()
    if not m:
        return
    with tenant_session(m.business_id) as tdb:
        tdb.add(Notification(business_id=m.business_id, kind="security", title=message, link="/activity"))
        audit.record(tdb, m.business_id, "system", "sign_in_locked", subject=f"user:{user.id}")


@router.post("/totp/setup")
def totp_setup(p: Principal = Depends(current_principal_partial)):
    if p.totp_enabled:
        raise HTTPException(400, "Two-step sign-in is already set up.")
    secret, enc = new_totp_secret()
    with global_session() as db:
        db.get(User, p.user_id).totp_secret_enc = enc
    return {"otpauth_uri": totp_uri(secret, p.email), "secret": secret}


@router.post("/totp/verify")
def totp_verify(body: CodeIn, request: Request, p: Principal = Depends(current_principal_partial)):
    limiter.check(f"totp:{p.user_id}", 10, 300)
    with global_session() as db:
        user = db.get(User, p.user_id)
        if not verify_totp(user.totp_secret_enc, body.code):
            raise HTTPException(401, "That code didn't work. Check the time on your phone and try again.")
        user.totp_enabled = True
        db.get(AuthSession, p.session_id).totp_passed = True
    with tenant_session(p.business_id) as tdb:
        audit.record(tdb, p.business_id, p.actor, "two_step_passed")
    return {"ok": True}


@router.post("/logout")
def logout(response: Response, p: Principal = Depends(current_principal_partial)):
    with global_session() as db:
        db.get(AuthSession, p.session_id).revoked = True
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(p: Principal = Depends(current_principal)):
    with tenant_session(p.business_id) as db:
        b = db.get(Business, p.business_id)
        unread = db.execute(
            select(func.count()).select_from(Notification).where(Notification.read.is_(False))
        ).scalar()
    return {
        "user": {"id": str(p.user_id), "name": p.name, "email": p.email, "roles": p.roles},
        "business": {
            "id": str(b.id), "name": b.name, "currency": b.currency, "country": b.country, "ai_paused": b.ai_paused,
        },
        "permissions": sorted(p.perms),
        "approval_limit_minor": p.approval_limit_minor,
        "levels": LEVEL_LABELS,
        "unread_notifications": unread,
    }
