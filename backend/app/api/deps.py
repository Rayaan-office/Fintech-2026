"""Request dependencies: who is signed in, which business, and what they may do."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import global_session, tenant_session
from ..models import AuthSession, Membership, User
from ..security.crypto import token_hash
from ..security.http import limiter
from ..security.rbac import TOTP_REQUIRED_ROLES, perms_for

SESSION_COOKIE = "sid"
_s = get_settings()


@dataclass
class Principal:
    user_id: UUID
    business_id: UUID
    email: str
    name: str
    roles: list[str]
    perms: set[str] = field(default_factory=set)
    approval_limit_minor: int | None = None
    second_approver: bool = False
    session_id: UUID | None = None
    totp_passed: bool = False
    totp_enabled: bool = False

    @property
    def actor(self) -> str:
        return f"user:{self.user_id}"

    def can(self, perm: str) -> bool:
        return perm in self.perms


def _load_session(request: Request) -> Principal | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    now = datetime.now(UTC)
    with global_session() as db:
        sess = db.execute(
            select(AuthSession).where(AuthSession.token_hash == token_hash(token), AuthSession.revoked.is_(False))
        ).scalar_one_or_none()
        if not sess:
            return None
        idle = now - sess.last_seen_at > timedelta(minutes=_s.session_idle_minutes)
        old = now - sess.created_at > timedelta(hours=_s.session_absolute_hours)
        if idle or old:
            sess.revoked = True
            return None
        sess.last_seen_at = now
        user = db.get(User, sess.user_id)
        m = db.execute(
            select(Membership).where(Membership.user_id == sess.user_id, Membership.business_id == sess.business_id)
        ).scalar_one_or_none()
        if not user or not m:
            return None
        return Principal(
            user_id=user.id, business_id=m.business_id, email=user.email, name=user.name, roles=list(m.roles),
            perms=perms_for(m.roles, m.second_approver), approval_limit_minor=m.approval_limit_minor,
            second_approver=m.second_approver, session_id=sess.id, totp_passed=sess.totp_passed,
            totp_enabled=user.totp_enabled,
        )


def current_principal_partial(request: Request) -> Principal:
    """Signed in with a password; two-step may still be pending."""
    p = _load_session(request)
    if not p:
        raise HTTPException(401, "Please sign in.")
    return p


def current_principal(request: Request) -> Principal:
    """Fully signed in, including two-step sign-in where the role needs it."""
    p = current_principal_partial(request)
    needs_totp = bool(set(p.roles) & TOTP_REQUIRED_ROLES) or p.second_approver
    if needs_totp and not p.totp_passed:
        raise HTTPException(401, "Two-step sign-in required.")
    limiter.check(f"user:{p.user_id}", 600, 60)
    return p


def require(perm: str):
    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if not p.can(perm):
            raise HTTPException(403, "Your role does not allow this.")
        return p

    return dep


def tenant_db(p: Principal = Depends(current_principal)) -> Iterator[Session]:
    with tenant_session(p.business_id) as db:
        yield db


def page_params(limit: int = 50, offset: int = 0) -> tuple[int, int]:
    return max(1, min(limit, 200)), max(0, offset)
