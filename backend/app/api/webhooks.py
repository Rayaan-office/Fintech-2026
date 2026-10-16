"""Incoming notifications. Unsigned or wrongly signed notifications are rejected."""

import ipaddress
import json
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from ..connectors import mailpit, quickbooks, stripe_conn
from ..connectors.common import get_connection, lookup_route, run_once_at_a_time, save_failure, seen_before
from ..db import global_session, tenant_session
from ..handlers import run_matching
from ..security import audit
from ..security.http import client_ip, limiter

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
log = logging.getLogger("copilot.webhooks")
MAX_BODY = 512 * 1024


async def _body(request: Request) -> bytes:
    body = await request.body()
    if len(body) > MAX_BODY:
        raise HTTPException(413, "Too large.")
    return body


def _resync(provider: str, business_id) -> None:
    if provider == "quickbooks":
        from .. import scheduler  # same read as the background schedule

        run_once_at_a_time(f"quickbooks:{business_id}", lambda: scheduler.read("quickbooks", business_id))
        return

    def once():
        try:
            with tenant_session(business_id) as db:
                stripe_conn.sync(db, business_id)
        except Exception as exc:
            log.warning("%s resync after notification failed: %s", provider, type(exc).__name__)
            save_failure(business_id, provider, f"Updating after a notification failed ({type(exc).__name__}).")
            return
        with tenant_session(business_id) as db:
            run_matching(db, business_id)

    run_once_at_a_time(f"{provider}:{business_id}", once)


@router.post("/stripe")
async def stripe_webhook(request: Request, tasks: BackgroundTasks):
    limiter.check(f"wh-stripe:{client_ip(request)}", 300, 60)
    body = await _body(request)
    try:
        event = stripe_conn.verify_webhook(body, request.headers.get("stripe-signature"))
    except Exception:
        raise HTTPException(400, "Invalid signature.")
    with global_session() as db:
        bid = lookup_route(db, "stripe", event.get("account") or "self")
    if not bid:
        return {"ignored": True}
    with tenant_session(bid) as db:
        c = get_connection(db, bid, "stripe", create=False)
        if not c or c.status == "disconnected":
            return {"ignored": True}
        if seen_before(db, bid, "stripe", event["id"]):
            return {"duplicate": True}
        if not stripe_conn.relevant(event["type"]):
            return {"ignored": True}
        audit.record(db, bid, "stripe", "notification_received", details={"type": event["type"], "id": event["id"]})
    # Re-read from Stripe rather than trusting the notification's contents
    tasks.add_task(_resync, "stripe", bid)
    return {"ok": True}


@router.post("/quickbooks")
async def quickbooks_webhook(request: Request, tasks: BackgroundTasks):
    """QuickBooks only says which company changed; we then read its change feed ourselves."""
    limiter.check(f"wh-qbo:{client_ip(request)}", 300, 60)
    body = await _body(request)
    if not quickbooks.verify_webhook(body, request.headers.get("intuit-signature")):
        raise HTTPException(401, "Invalid signature.")
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(400, "Not JSON.")
    due = set()
    for event_id, realm in quickbooks.notices(payload):
        with global_session() as db:
            bid = lookup_route(db, "quickbooks", realm)
        if not bid:
            continue
        with tenant_session(bid) as db:
            c = get_connection(db, bid, "quickbooks", create=False)
            if not c or c.status != "connected" or seen_before(db, bid, "quickbooks", event_id):
                continue
            audit.record(db, bid, "quickbooks", "notification_received", details={"id": event_id})
        due.add(bid)
    for bid in due:  # one read per company, however many notifications
        tasks.add_task(_resync, "quickbooks", bid)
    return {"ok": True}


def _is_local(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return a.is_loopback or a.is_private
    except ValueError:
        return ip == "testclient"


@router.post("/mailpit")
async def mailpit_webhook(request: Request, tasks: BackgroundTasks):
    """Mailpit runs on our own network and only tells us a message ID; we fetch the message ourselves."""
    if not _is_local(client_ip(request)):
        raise HTTPException(403, "Refused.")
    limiter.check("wh-mailpit", 600, 60)
    try:
        body = json.loads(await _body(request))
    except ValueError:
        raise HTTPException(400, "Bad message ID.")
    message_id = str(body.get("ID", "") if isinstance(body, dict) else "")[:64]
    if not message_id or not message_id.replace("-", "").isalnum():
        raise HTTPException(400, "Bad message ID.")
    tasks.add_task(_handle_mail, message_id)
    return {"ok": True}


def _handle_mail(message_id: str) -> None:
    try:
        for outcome in mailpit.handle_new_message(message_id):
            log.info("email %s: %d document(s)%s", outcome.status, len(outcome.documents),
                     f", {outcome.reason}" if outcome.reason else "")
    except Exception as exc:
        log.warning("email intake failed: %s", type(exc).__name__)
