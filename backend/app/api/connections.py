"""Connections page: connect, sync and disconnect the business's tools."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
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
PROVIDER_LABEL = {"mailpit": "Mailpit test inbox", "stripe": "Stripe sandbox (UK)", "plaid": "Plaid sandbox (UK)",
                  "quickbooks": "QuickBooks sandbox (UK)"}


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
    if isinstance(exc, (plaid_conn.PlaidError, quickbooks.QBOError)):
        return (409 if exc.expired or exc.code == "NOT_CONNECTED" else 502), exc.for_person(), exc.expired
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


def _never_connected(exc: Exception) -> bool:
    """Nothing to remember on the card: it already says "not connected"."""
    return isinstance(exc, (plaid_conn.PlaidError, quickbooks.QBOError)) and exc.code == "NOT_CONNECTED"


def _run(p: Principal, provider: str, fn, *args):
    limiter.check(f"sync:{p.business_id}:{provider}", 6, 60)
    try:
        with tenant_session(p.business_id) as db:
            counts = fn(db, p.business_id, *args)
    except Exception as exc:
        status, message, expired = _failure(provider, exc)
        if not _never_connected(exc):
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
    elif provider == "quickbooks":
        quickbooks.disconnect(db, p.business_id)
    elif provider == "stripe":
        c = get_connection(db, p.business_id, provider)
        c.token_enc, c.status = None, "disconnected"
    else:
        raise HTTPException(400, "The email inbox is required and can't be disconnected.")
    audit.record(db, p.business_id, p.actor, "connection_removed", subject=provider)
    return {"ok": True}


QBO_COOKIE = "qbo_signin"


def _signin_cookie(response: Response, nonce: str) -> None:
    response.set_cookie(QBO_COOKIE, nonce, max_age=600, httponly=True, samesite="lax", path="/connect/quickbooks",
                        secure=_s.app_base_url.startswith("https:"))


@router.get("/api/connections/quickbooks/start")
def qbo_start(response: Response, p: Principal = Depends(require(Perm.CONNECT_TOOLS))):
    """The Intuit sign-in address. This browser keeps a one-time value that the callback checks."""
    url, nonce = quickbooks.authorize_url(p.business_id, p.user_id)
    _signin_cookie(response, nonce)
    return {"url": url}


@router.get("/connect/quickbooks/start")
def qbo_go(p: Principal = Depends(require(Perm.CONNECT_TOOLS))):
    """The same, as a link: goes straight to Intuit's sign-in page."""
    url, nonce = quickbooks.authorize_url(p.business_id, p.user_id)
    r = RedirectResponse(url, status_code=303)
    _signin_cookie(r, nonce)
    return r


@router.get("/connect/quickbooks/callback")
def qbo_callback(request: Request, code: str | None = None, state: str | None = None, realmId: str | None = None,
                 error: str | None = None, p: Principal = Depends(current_principal)):
    back = f"{_s.app_base_url}/connections"

    def done(outcome: str) -> RedirectResponse:
        r = RedirectResponse(f"{back}?qbo={outcome}", status_code=303)
        r.delete_cookie(QBO_COOKIE, path="/connect/quickbooks")  # used once
        return r

    if error or not code or not state or not realmId:
        return done("cancelled")
    try:
        bid, uid = quickbooks.check_state(state, request.cookies.get(QBO_COOKIE))
    except (ValueError, KeyError):
        return done("failed")
    if bid != str(p.business_id) or uid != str(p.user_id) or not p.can(Perm.CONNECT_TOOLS):
        return done("failed")
    try:
        with tenant_session(p.business_id) as db:
            quickbooks.finish_connect(db, p.business_id, code[:512], realmId)
            audit.record(db, p.business_id, p.actor, "connection_added", subject="quickbooks")
    except PermissionError:
        return done("taken")
    except quickbooks.QBOError:
        return done("failed")
    try:
        _run(p, "quickbooks", quickbooks.sync, True)
    except HTTPException:
        return done("connected_sync_failed")
    return done("connected")
