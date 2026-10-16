"""Background schedule: reads every connected bank account and accounting company, because
without a public address neither Plaid nor QuickBooks can notify us.

Runs inside the API process. Each bank is read every BANK_POLL_MINUTES, and every minute while
Plaid is still sending the first history. Each accounting company's change feed is read every
BOOKS_POLL_MINUTES. Postgres locks keep two API processes from reading the same one at once.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from .config import get_settings
from .connectors import plaid_conn, quickbooks
from .connectors.common import get_connection, run_once_at_a_time, save_failure
from .db import global_session, tenant_session
from .handlers import run_matching
from .models import Connection, ConnectionRoute
from .security import audit

_s = get_settings()
log = logging.getLogger("copilot.scheduler")
_scheduler: BackgroundScheduler | None = None


def _bank_due(c: Connection, now: datetime) -> bool:
    if (c.meta or {}).get("update_status") != plaid_conn.HISTORY_DONE or not c.last_sync_at:
        return True
    return now - c.last_sync_at >= timedelta(minutes=_s.bank_poll_minutes)


def _books_due(c: Connection, now: datetime) -> bool:
    return not c.last_sync_at or now - c.last_sync_at >= timedelta(minutes=_s.books_poll_minutes)


# provider -> (sync, its error type, what to say when something else goes wrong, is it due, what counts as a change)
SOURCES: dict[str, tuple[Callable, type, str, Callable, tuple[str, ...]]] = {
    "plaid": (plaid_conn.sync, plaid_conn.PlaidError, "Reading the bank account failed. We'll try again shortly.",
              _bank_due, ("added", "modified", "removed")),
    "quickbooks": (quickbooks.sync, quickbooks.QBOError, "Reading QuickBooks failed. We'll try again shortly.",
                   _books_due, ("added", "changed", "removed")),
}


def read(provider: str, business_id) -> None:
    """Read one connection now, remembering a failure on its card."""
    sync, error, fallback, _, changes = SOURCES[provider]
    try:
        with tenant_session(business_id) as db:
            counts = sync(db, business_id)
    except Exception as exc:
        if isinstance(exc, error):
            message, expired = exc.for_person(), exc.expired
        else:
            message, expired = fallback, False
        log.warning("scheduled %s read failed: %s", provider, getattr(exc, "code", type(exc).__name__))
        save_failure(business_id, provider, message, expired)
        return
    with tenant_session(business_id) as db:
        matched = run_matching(db, business_id)
        if any(counts.get(k) for k in changes):  # quiet reads don't fill the activity log
            audit.record(db, business_id, "scheduler", "connection_synced", subject=provider,
                         details={**counts, **matched})


def _poll(provider: str, now: datetime | None) -> list:
    now = now or datetime.now(UTC)
    due_fn = SOURCES[provider][3]
    with global_session() as db:
        businesses = sorted(set(db.execute(select(ConnectionRoute.business_id)
                                           .where(ConnectionRoute.kind == provider)).scalars()), key=str)
    read_now = []
    for bid in businesses:
        with tenant_session(bid) as db:
            c = get_connection(db, bid, provider, create=False)
            # expired ones wait for the person to reconnect
            due = bool(c and c.status == "connected" and due_fn(c, now))
        if due:
            run_once_at_a_time(f"{provider}:{bid}", lambda bid=bid: read(provider, bid))
            read_now.append(bid)
    return read_now


def poll_banks(now: datetime | None = None) -> list:
    """Read each bank that is due. Returns the businesses read."""
    return _poll("plaid", now)


def poll_books(now: datetime | None = None) -> list:
    """Read each accounting company that is due. Returns the businesses read."""
    return _poll("quickbooks", now)


def poll_all() -> None:
    for poll in (poll_banks, poll_books):
        try:
            poll()
        except Exception:  # one source failing must not stop the other
            log.exception("scheduled poll failed")


def start() -> None:
    global _scheduler
    if _scheduler or not _s.scheduler_enabled or _s.app_env == "test":
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    # One run at a time; a run that is late (the laptop slept) is merged into the next one
    _scheduler.add_job(poll_all, "interval", minutes=1, id="poll", max_instances=1, coalesce=True,
                       next_run_time=datetime.now(UTC) + timedelta(seconds=20))
    _scheduler.start()
    log.info("background schedule started: banks every %s minutes, accounting every %s minutes",
             _s.bank_poll_minutes, _s.books_poll_minutes)


def stop() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
