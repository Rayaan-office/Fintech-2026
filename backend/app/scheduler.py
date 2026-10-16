"""Background schedule: reads every connected bank account, because Plaid can't notify us
without a public address.

Runs inside the API process. Each bank is read every BANK_POLL_MINUTES, and every minute while
Plaid is still sending the first history. Postgres locks keep two API processes from reading
the same bank at once.
"""

import logging
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from .config import get_settings
from .connectors import plaid_conn
from .connectors.common import get_connection, run_once_at_a_time, save_failure
from .db import global_session, tenant_session
from .handlers import run_matching
from .models import Connection, ConnectionRoute
from .security import audit

_s = get_settings()
log = logging.getLogger("copilot.scheduler")
_scheduler: BackgroundScheduler | None = None


def _due(c: Connection | None, now: datetime) -> bool:
    if not c or c.status != "connected":  # expired ones wait for the person to reconnect
        return False
    if (c.meta or {}).get("update_status") != plaid_conn.HISTORY_DONE or not c.last_sync_at:
        return True
    return now - c.last_sync_at >= timedelta(minutes=_s.bank_poll_minutes)


def _read_bank(business_id) -> None:
    try:
        with tenant_session(business_id) as db:
            counts = plaid_conn.sync(db, business_id)
    except Exception as exc:
        if isinstance(exc, plaid_conn.PlaidError):
            message, expired = exc.for_person(), exc.expired
        else:
            message, expired = "Reading the bank account failed. We'll try again shortly.", False
        log.warning("scheduled bank read failed: %s", getattr(exc, "code", type(exc).__name__))
        save_failure(business_id, "plaid", message, expired)
        return
    changed = counts["added"] + counts["modified"] + counts["removed"]
    with tenant_session(business_id) as db:
        matched = run_matching(db, business_id)
        if changed:  # quiet reads don't fill the activity log
            audit.record(db, business_id, "scheduler", "connection_synced", subject="plaid",
                         details={**counts, **matched})


def poll_banks(now: datetime | None = None) -> list:
    """Read each bank that is due. Returns the businesses read."""
    now = now or datetime.now(UTC)
    with global_session() as db:
        businesses = sorted(set(db.execute(select(ConnectionRoute.business_id)
                                           .where(ConnectionRoute.kind == "plaid")).scalars()), key=str)
    read = []
    for bid in businesses:
        with tenant_session(bid) as db:
            due = _due(get_connection(db, bid, "plaid", create=False), now)
        if due:
            run_once_at_a_time(f"plaid:{bid}", lambda bid=bid: _read_bank(bid))
            read.append(bid)
    return read


def start() -> None:
    global _scheduler
    if _scheduler or not _s.scheduler_enabled or _s.app_env == "test":
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    # One run at a time; a run that is late (the laptop slept) is merged into the next one
    _scheduler.add_job(poll_banks, "interval", minutes=1, id="poll_banks", max_instances=1, coalesce=True,
                       next_run_time=datetime.now(UTC) + timedelta(seconds=20))
    _scheduler.start()
    log.info("background schedule started: banks every %s minutes", _s.bank_poll_minutes)


def stop() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
