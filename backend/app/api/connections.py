"""Connections page: connect, sync and disconnect the business's tools."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..connectors import mailpit, plaid_conn, quickbooks, stripe_conn
from ..connectors.common import get_connection, save_failure
from ..db import tenant_session
from ..handlers import run_matching
from ..models import Account, Connection
from ..security import audit
from ..security.http import limiter
from ..security.rbac import Perm
from .deps import Principal, current_principal, require, tenant_db

router = APIRouter(tags=["connections"])
_s = get_settings()

CARDS = [
    ("email", "mailpit", "Email inbox", "Bills, receipts and payment notices", True),
    ("payments", "stripe", "Payment platform", "Money customers paid", False),
    ("bank", "plaid", "Bank account", "Money in and out of the bank", False),
    ("accounting", "quickbooks", "Accounting software", "The official books", False),
]
PROVIDER_LABEL = {"mailpit": "Mailpit test inbox", "stripe": "Stripe sandbox (UK)", "plaid": "Plaid test bank",
                  "quickbooks": "QuickBooks test company"}


def _card(c: Connection | None, kind, provider, title, what, required) -> dict:
    return {
        "kind": kind, "provider": provider, "provider_label": PROVIDER_LABEL[provider], "title": title,
        "what": what, "required": required, "status": c.status if c else "disconnected",
        "last_sync_at": c.last_sync_at.isoformat() if c and c.last_sync_at else None,
        "error": c.last_error if c else None, "counts": (c.meta or {}).get("last_counts") if c else None,
        "address": (c.meta or {}).get("address") if c else None,
    }


@router.get("/api/connections")
def list_connections(p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(tenant_db)):
    rows = {c.kind: c for c in db.execute(select(Connection)).scalars()}
    accounts = db.execute(select(Account)).scalars().all()
    return {
        "items": [_card(rows.get(k), k, pr, t, w, r) for k, pr, t, w, r in CARDS],
        "accounts": [{"id": str(a.id), "source": a.source, "name": a.name, "mask": a.mask, "currency": a.currency,
                      "balance_minor": a.balance_minor, "as_of": a.as_of.isoformat()} for a in accounts],
    }


def _failure(provider: str, exc: Exception) -> tuple[int, str, bool]:
    """(HTTP status, message for the person, connection has expired)."""
    if isinstance(exc, quickbooks.NeedsReconnect):
        return 409, "The QuickBooks connection has expired. Reconnect.", True
    if isinstance(exc, plaid_conn.PlaidError):
        if exc.code == "ITEM_LOGIN_REQUIRED":
            return 502, "The bank connection has expired. Reconnect.", True
        return 502, "The bank didn't respond. Try again in a minute.", False
    if isinstance(exc, stripe_conn.StripeError):
        if exc.status == 401:
            return 502, "Stripe rejected our key. Check the payment platform key in the settings.", True
        if exc.status == 403:
            return 502, "Our Stripe key isn't allowed to read everything we need. Check its read permissions.", False
        if exc.status == 0:
            return 409, exc.message, False
    if isinstance(exc, PermissionError):
        return 409, "This account is already connected to another business.", False
    return 502, f"We couldn't reach {PROVIDER_LABEL[provider]}. Try again in a minute.", False


def _run(p: Principal, provider: str, fn, *args):
    limiter.check(f"sync:{p.business_id}:{provider}", 6, 60)
    try:
        with tenant_session(p.business_id) as db:
            counts = fn(db, p.business_id, *args)
    except Exception as exc:
        status, message, expired = _failure(provider, exc)
        save_failure(p.business_id, provider, message, expired)
        raise HTTPException(status, message)
    # Commit sync results first, then match in a new transaction
    with tenant_session(p.business_id) as db:
        matched = run_matching(db, p.business_id)
        audit.record(db, p.business_id, p.actor, "connection_synced", subject=provider, details={**counts, **matched})
    return {"ok": True, "counts": counts, "matched": matched}


@router.post("/api/connections/stripe/connect")
def connect_stripe(p: Principal = Depends(require(Perm.CONNECT_TOOLS))):
    return _run(p, "stripe", stripe_conn.connect)


@router.post("/api/connections/plaid/connect")
def connect_plaid(p: Principal = Depends(require(Perm.CONNECT_TOOLS))):
    from ..demo.bank import custom_user

    return _run(p, "plaid", plaid_conn.connect_sandbox, custom_user())


@router.post("/api/connections/{provider}/sync")
def sync_now(provider: str, p: Principal = Depends(require(Perm.VIEW_ALL))):
    # For the email inbox, "sync" catches up on emails that arrived while our app wasn't listening
    fns = {"stripe": stripe_conn.sync, "plaid": plaid_conn.sync, "quickbooks": quickbooks.sync, "mailpit": mailpit.sync}
    if provider not in fns:
        raise HTTPException(404, "Not found.")
    return _run(p, provider, fns[provider])


@router.post("/api/connections/{provider}/disconnect")
def disconnect(provider: str, p: Principal = Depends(require(Perm.CONNECT_TOOLS)), db: Session = Depends(tenant_db)):
    if provider == "plaid":
        plaid_conn.disconnect(db, p.business_id)
    elif provider in ("stripe", "quickbooks"):
        c = get_connection(db, p.business_id, provider)
        c.token_enc, c.status = None, "disconnected"
    else:
        raise HTTPException(400, "The email inbox is required and can't be disconnected.")
    audit.record(db, p.business_id, p.actor, "connection_removed", subject=provider)
    return {"ok": True}


@router.get("/api/connections/quickbooks/start")
def qbo_start(p: Principal = Depends(require(Perm.CONNECT_TOOLS))):
    return {"url": quickbooks.authorize_url(p.business_id, p.user_id)}


@router.get("/connect/quickbooks/callback")
def qbo_callback(request: Request, code: str | None = None, state: str | None = None, realmId: str | None = None,
                 error: str | None = None, p: Principal = Depends(current_principal)):
    back = f"{_s.app_base_url}/connections"
    if error or not code or not state or not realmId:
        return RedirectResponse(f"{back}?qbo=cancelled", status_code=303)
    try:
        bid, uid = quickbooks.check_state(state)
    except ValueError:
        return RedirectResponse(f"{back}?qbo=failed", status_code=303)
    if bid != str(p.business_id) or uid != str(p.user_id) or not p.can(Perm.CONNECT_TOOLS):
        return RedirectResponse(f"{back}?qbo=failed", status_code=303)
    with tenant_session(p.business_id) as db:
        try:
            quickbooks.finish_connect(db, p.business_id, code, realmId)
        except (quickbooks.NeedsReconnect, PermissionError):
            return RedirectResponse(f"{back}?qbo=failed", status_code=303)
        audit.record(db, p.business_id, p.actor, "connection_added", subject="quickbooks")
    try:
        _run(p, "quickbooks", quickbooks.sync, True)
    except HTTPException:
        return RedirectResponse(f"{back}?qbo=connected_sync_failed", status_code=303)
    return RedirectResponse(f"{back}?qbo=connected", status_code=303)
