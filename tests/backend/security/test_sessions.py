"""Sign-in sessions end after a quiet spell and after a fixed total time, whatever the person does."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import global_session
from app.models import AuthSession
from app.security.crypto import token_hash


def _age(c, *, idle: timedelta = timedelta(0), total: timedelta = timedelta(0)) -> None:
    """Make the browser's session look `idle` since its last request and `total` old."""
    now = datetime.now(UTC)
    with global_session() as db:
        s = db.execute(select(AuthSession).where(AuthSession.token_hash == token_hash(c.cookies["sid"]))).scalar_one()
        s.last_seen_at, s.created_at = now - idle, now - total


def _revoked(c) -> bool:
    with global_session() as db:
        return db.execute(select(AuthSession.revoked)
                          .where(AuthSession.token_hash == token_hash(c.cookies["sid"]))).scalar_one()


@pytest.mark.parametrize("email", ["books@a.test", "owner@a.test"])
def test_a_quiet_session_ends(sign_in, settings, email):
    c = sign_in(email)
    _age(c, idle=timedelta(minutes=settings.session_idle_minutes - 1))
    assert c.get("/api/auth/me").status_code == 200  # still within the quiet spell
    _age(c, idle=timedelta(minutes=settings.session_idle_minutes + 1))
    assert c.get("/api/auth/me").status_code == 401
    assert _revoked(c)
    _age(c)  # coming back afterwards does not bring it back to life
    assert c.get("/api/auth/me").status_code == 401


def test_a_busy_session_still_ends_after_its_total_time(sign_in, settings):
    c = sign_in("books@a.test")
    _age(c, total=timedelta(hours=settings.session_absolute_hours) - timedelta(minutes=5))
    assert c.get("/api/auth/me").status_code == 200
    _age(c, total=timedelta(hours=settings.session_absolute_hours) + timedelta(minutes=1))  # used a moment ago
    assert c.get("/api/auth/me").status_code == 401
    assert _revoked(c)
