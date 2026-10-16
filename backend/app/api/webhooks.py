"""Incoming notifications. Unsigned or wrongly signed notifications are rejected."""

import ipaddress
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from ..connectors import mailpit, quickbooks, stripe_conn
from ..connectors.common import lookup_route, seen_before
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
    fn = {"stripe": stripe_conn.sync, "quickbooks": quickbooks.sync}[provider]
    try:
        with tenant_session(business_id) as db:
            fn(db, business_id)
        with tenant_session(business_id) as db:
            run_matching(db, business_id)
    except Exception as exc:
        log.warning("%s resync after notification failed: %s", provider, type(exc).__name__)


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
        if seen_before(db, bid, "stripe", event["id"]):
            return {"duplicate": True}
        audit.record(db, bid, "stripe", "notification_received", details={"type": event["type"], "id": event["id"]})
    # Re-read from Stripe rather than trusting the notification's contents
    tasks.add_task(_resync, "stripe", bid)
    return {"ok": True}


@router.post("/quickbooks")
async def quickbooks_webhook(request: Request, tasks: BackgroundTasks):
    body = await _body(request)
    if not quickbooks.verify_webhook(body, request.headers.get("intuit-signature")):
        raise HTTPException(401, "Invalid signature.")
    import json

    payload = json.loads(body)
    for note in payload.get("eventNotifications", [])[:20]:
        realm = str(note.get("realmId", ""))
        with global_session() as db:
            bid = lookup_route(db, "quickbooks", realm)
        if bid:
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
    body = await request.json()
    message_id = str(body.get("ID", ""))[:64]
    if not message_id.replace("-", "").isalnum():
        raise HTTPException(400, "Bad message ID.")
    tasks.add_task(_handle_mail, message_id)
    return {"ok": True}


def _handle_mail(message_id: str) -> None:
    try:
        mailpit.handle_new_message(message_id)
    except Exception as exc:
        log.warning("email intake failed: %s", type(exc).__name__)
