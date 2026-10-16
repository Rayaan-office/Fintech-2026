"""Accounting software: QuickBooks Online (sandbox company). Accounting scope only.

We read customers, suppliers, invoices, bills and payments. We write only after a person
approves (level 3): a bill with its original document attached. Changes are picked up by
polling QuickBooks' change feed (Change Data Capture); signed webhooks also work when a
public address is available.
"""

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account, Counterparty, Record
from ..pipeline.counterparties import find_or_create
from . import outbound
from .common import get_connection, load_secret, mark_error, mark_synced, route, save_secret, upsert_record

_s = get_settings()
AUTH_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
API = {"sandbox": "https://sandbox-quickbooks.api.intuit.com", "production": "https://quickbooks.api.intuit.com"}[
    _s.qbo_environment]
MINOR_VERSION = "75"
ENTITIES = ["Customer", "Vendor", "Invoice", "Bill", "Payment", "BillPayment", "Purchase", "Account"]


class NeedsReconnect(Exception):
    pass


# ── Sign-in with Intuit (OAuth 2.0) ────────────────────────────────────────


def _sign(payload: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    mac = hmac.new(_s.session_secret.get_secret_value().encode(), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{mac}"


def _unsign(state: str) -> dict:
    raw, _, mac = state.partition(".")
    good = hmac.new(_s.session_secret.get_secret_value().encode(), raw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, good):
        raise ValueError("bad state")
    data = json.loads(base64.urlsafe_b64decode(raw))
    if data["exp"] < time.time():
        raise ValueError("expired state")
    return data


def authorize_url(business_id, user_id) -> str:
    state = _sign({"b": str(business_id), "u": str(user_id), "exp": int(time.time()) + 600,
                   "n": base64.urlsafe_b64encode(hashlib.sha256(str(time.time_ns()).encode()).digest()[:9]).decode()})
    return AUTH_URL + "?" + urlencode({"client_id": _s.qbo_client_id, "response_type": "code",
                                       "scope": _s.qbo_scopes, "redirect_uri": _s.qbo_redirect_uri, "state": state})


def check_state(state: str) -> tuple[str, str]:
    d = _unsign(state)
    return d["b"], d["u"]


def _token_request(data: dict) -> dict:
    with outbound.client(timeout=20) as http:
        r = http.post(TOKEN_URL, data=data, auth=(_s.qbo_client_id, _s.qbo_client_secret.get_secret_value()),
                      headers={"Accept": "application/json"})
    if r.status_code != 200:
        raise NeedsReconnect(f"Intuit token request failed ({r.status_code})")
    t = r.json()
    t["expires_at"] = time.time() + int(t.get("expires_in", 3600)) - 60
    return t


def finish_connect(db: Session, business_id, code: str, realm_id: str) -> None:
    t = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": _s.qbo_redirect_uri})
    c = get_connection(db, business_id, "quickbooks")
    save_secret(c, {"access_token": t["access_token"], "refresh_token": t["refresh_token"],
                    "expires_at": t["expires_at"], "realm_id": realm_id})
    c.status = "connected"
    c.meta = {**(c.meta or {}), "realm_id": realm_id, "mode": _s.qbo_environment}
    route(db, "quickbooks", realm_id, business_id)
    db.flush()


def _access(db: Session, c) -> tuple[str, str]:
    sec = load_secret(c)
    if not sec:
        raise NeedsReconnect("QuickBooks is not connected")
    if sec["expires_at"] < time.time():
        t = _token_request({"grant_type": "refresh_token", "refresh_token": sec["refresh_token"]})
        sec.update(access_token=t["access_token"], refresh_token=t.get("refresh_token", sec["refresh_token"]),
                   expires_at=t["expires_at"])
        save_secret(c, sec)
    return sec["access_token"], sec["realm_id"]


def _api(db: Session, c, method: str, path: str, **kw) -> dict:
    token, realm = _access(db, c)
    url = f"{API}/v3/company/{realm}/{path}"
    params = {"minorversion": MINOR_VERSION, **kw.pop("params", {})}
    with outbound.client(timeout=30) as http:
        r = http.request(method, url, params=params, headers={"Authorization": f"Bearer {token}",
                                                               "Accept": "application/json", **kw.pop("headers", {})}, **kw)
    if r.status_code == 401:
        raise NeedsReconnect("QuickBooks sign-in expired")
    if r.status_code >= 400:
        raise RuntimeError(f"QuickBooks answered {r.status_code}: {r.text[:200]}")
    return r.json()


def _query(db: Session, c, entity: str, where: str = "") -> list[dict]:
    out, start = [], 1
    while True:
        q = f"select * from {entity} {where} startposition {start} maxresults 500"
        resp = _api(db, c, "GET", "query", params={"query": q}).get("QueryResponse", {})
        rows = resp.get(entity, [])
        out.extend(rows)
        if len(rows) < 500 or start > 5000:
            return out
        start += 500


# ── Reading ────────────────────────────────────────────────────────────────


def _d(s: str | None) -> date | None:
    return date.fromisoformat(s[:10]) if s else None


def _m(v) -> int:
    return round(float(v or 0) * 100)


def sync(db: Session, business_id, full: bool = False) -> dict:
    c = get_connection(db, business_id, "quickbooks")
    counts = {e: 0 for e in ENTITIES}
    try:
        since = (c.meta or {}).get("cdc_since")
        if full or not since:
            data = {e: _query(db, c, e) for e in ENTITIES}
        else:
            resp = _api(db, c, "GET", "cdc", params={"entities": ",".join(ENTITIES), "changedSince": since})
            data = {e: [] for e in ENTITIES}
            for block in resp.get("CDCResponse", [{}])[0].get("QueryResponse", []):
                for e in ENTITIES:
                    data[e].extend(block.get(e, []))
        started = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        company_currency = (c.meta or {}).get("currency")
        if not company_currency:
            info = _api(db, c, "GET", "preferences").get("Preferences", {})
            company_currency = (info.get("CurrencyPrefs", {}).get("HomeCurrency") or {}).get("value", "USD")

        cps: dict[tuple[str, str], Counterparty] = {}
        for kind, entity in (("customer", "Customer"), ("supplier", "Vendor")):
            for row in data[entity]:
                name = row.get("DisplayName") or row.get("CompanyName") or row["Id"]
                cp, _ = find_or_create(db, business_id, kind, name)
                cp.external_ids = {**(cp.external_ids or {}), "quickbooks": row["Id"]}
                email_addr = (row.get("PrimaryEmailAddr") or {}).get("Address", "")
                if email_addr and "@" in email_addr and not cp.email_domain:
                    cp.email_domain = email_addr.split("@")[1].lower()
                terms = (row.get("SalesTermRef") or row.get("TermRef") or {}).get("name", "")
                if terms.lower().startswith("net "):
                    cp.payment_terms_days = int(terms.split()[1]) if terms.split()[1].isdigit() else None
                cps[(kind, row["Id"])] = cp
                counts[entity] += 1
        known = {(c2.kind, (c2.external_ids or {}).get("quickbooks")): c2 for c2 in
                 db.execute(select(Counterparty)).scalars() if (c2.external_ids or {}).get("quickbooks")}
        cps = {**known, **cps}

        def cp_id(kind, ref):
            cp = cps.get((kind, (ref or {}).get("value")))
            return cp.id if cp else None

        for inv in data["Invoice"]:
            total, bal = _m(inv.get("TotalAmt")), _m(inv.get("Balance"))
            upsert_record(db, business_id, "quickbooks", f"Invoice:{inv['Id']}", kind="invoice", direction="in",
                          amount_minor=total, open_minor=bal, currency=(inv.get("CurrencyRef") or {}).get("value", company_currency),
                          date=_d(inv.get("TxnDate")), due_date=_d(inv.get("DueDate")),
                          status="open" if bal > 0 else "paid", counterparty_id=cp_id("customer", inv.get("CustomerRef")),
                          reference=inv.get("DocNumber"), description=f"Invoice {inv.get('DocNumber') or ''}"[:500],
                          category="sales", tax_minor=_m((inv.get("TxnTaxDetail") or {}).get("TotalTax")),
                          external={"qbo_id": inv["Id"], "qbo_type": "Invoice"})
            counts["Invoice"] += 1
        for b in data["Bill"]:
            total, bal = _m(b.get("TotalAmt")), _m(b.get("Balance"))
            cat = None
            for line in b.get("Line", []):
                ref = (line.get("AccountBasedExpenseLineDetail") or {}).get("AccountRef") or {}
                cat = cat or (ref.get("name") or "").split(":")[-1].strip().lower() or None
            upsert_record(db, business_id, "quickbooks", f"Bill:{b['Id']}", kind="bill", direction="out",
                          amount_minor=total, open_minor=bal, currency=(b.get("CurrencyRef") or {}).get("value", company_currency),
                          date=_d(b.get("TxnDate")), due_date=_d(b.get("DueDate")), status="open" if bal > 0 else "paid",
                          counterparty_id=cp_id("supplier", b.get("VendorRef")), reference=b.get("DocNumber"),
                          description=f"Bill {b.get('DocNumber') or ''}"[:500], category=cat,
                          external={"qbo_id": b["Id"], "qbo_type": "Bill"})
            counts["Bill"] += 1
        for pmt in data["Payment"]:
            upsert_record(db, business_id, "quickbooks", f"Payment:{pmt['Id']}", kind="payment_in", direction="in",
                          amount_minor=_m(pmt.get("TotalAmt")), open_minor=0,
                          currency=(pmt.get("CurrencyRef") or {}).get("value", company_currency), date=_d(pmt.get("TxnDate")),
                          status="posted", counterparty_id=cp_id("customer", pmt.get("CustomerRef")),
                          reference=pmt.get("PaymentRefNum"), description="Customer payment", category="sales",
                          external={"qbo_id": pmt["Id"], "qbo_type": "Payment",
                                    "linked": [lt.get("TxnId") for ln in pmt.get("Line", []) for lt in ln.get("LinkedTxn", [])]})
            counts["Payment"] += 1
        for bp in data["BillPayment"]:
            upsert_record(db, business_id, "quickbooks", f"BillPayment:{bp['Id']}", kind="payment_out", direction="out",
                          amount_minor=_m(bp.get("TotalAmt")), open_minor=0,
                          currency=(bp.get("CurrencyRef") or {}).get("value", company_currency), date=_d(bp.get("TxnDate")),
                          status="posted", counterparty_id=cp_id("supplier", bp.get("VendorRef")),
                          reference=bp.get("DocNumber"), description="Bill payment", category=None,
                          external={"qbo_id": bp["Id"], "qbo_type": "BillPayment",
                                    "linked": [lt.get("TxnId") for ln in bp.get("Line", []) for lt in ln.get("LinkedTxn", [])]})
            counts["BillPayment"] += 1
        for pu in data["Purchase"]:
            cat = None
            for line in pu.get("Line", []):
                ref = (line.get("AccountBasedExpenseLineDetail") or {}).get("AccountRef") or {}
                cat = cat or (ref.get("name") or "").split(":")[-1].strip().lower() or None
            upsert_record(db, business_id, "quickbooks", f"Purchase:{pu['Id']}", kind="payment_out", direction="out",
                          amount_minor=_m(pu.get("TotalAmt")), open_minor=0,
                          currency=(pu.get("CurrencyRef") or {}).get("value", company_currency), date=_d(pu.get("TxnDate")),
                          status="posted", counterparty_id=cp_id("supplier", pu.get("EntityRef")),
                          reference=pu.get("DocNumber"), description=f"Purchase {pu.get('PaymentType', '')}"[:500],
                          category=cat, external={"qbo_id": pu["Id"], "qbo_type": "Purchase"})
            counts["Purchase"] += 1
        expense_accounts = [{"id": a["Id"], "name": a["Name"]} for a in data["Account"]
                            if a.get("AccountType") in ("Expense", "Cost of Goods Sold")]
        meta = {**(c.meta or {}), "cdc_since": started, "currency": company_currency}
        if expense_accounts:
            meta["expense_accounts"] = expense_accounts[:200]
        c.meta = meta
        mark_synced(db, c, counts)
    except NeedsReconnect as e:
        mark_error(db, c, "The QuickBooks connection has expired. Reconnect.", expired=True)
        raise
    except Exception as exc:
        mark_error(db, c, f"QuickBooks sync failed: {str(exc)[:150]}")
        raise
    return counts


# ── Writing (only after approval) ──────────────────────────────────────────


def _expense_account(c, category: str | None) -> str:
    accounts = (c.meta or {}).get("expense_accounts") or []
    if not accounts:
        raise RuntimeError("no expense account found in QuickBooks")
    if category:
        for a in accounts:
            if category.lower() in a["name"].lower():
                return a["id"]
    for pref in ("Supplies", "Purchases", "Cost of Goods Sold", "Office"):
        for a in accounts:
            if pref.lower() in a["name"].lower():
                return a["id"]
    return accounts[0]["id"]


def _vendor_id(db: Session, c, cp: Counterparty) -> str:
    vid = (cp.external_ids or {}).get("quickbooks")
    if vid:
        return vid
    safe = cp.display_name.replace("'", "\\'")
    found = _query(db, c, "Vendor", f"where DisplayName = '{safe}'")
    if found:
        vid = found[0]["Id"]
    else:
        vid = _api(db, c, "POST", "vendor", json={"DisplayName": cp.display_name[:100]})["Vendor"]["Id"]
    cp.external_ids = {**(cp.external_ids or {}), "quickbooks": vid}
    return vid


def post_bill(db: Session, business_id, record: Record, original: bytes, filename: str, mime: str) -> dict:
    c = get_connection(db, business_id, "quickbooks")
    cp = db.get(Counterparty, record.counterparty_id)
    body = {
        "VendorRef": {"value": _vendor_id(db, c, cp)},
        "TxnDate": record.date.isoformat(),
        "Line": [{"DetailType": "AccountBasedExpenseLineDetail", "Amount": record.amount_minor / 100,
                  "Description": (record.description or "")[:4000],
                  "AccountBasedExpenseLineDetail": {"AccountRef": {"value": _expense_account(c, record.category)}}}],
    }
    if record.due_date:
        body["DueDate"] = record.due_date.isoformat()
    if record.reference:
        body["DocNumber"] = record.reference[:21]
    bill = _api(db, c, "POST", "bill", json=body)["Bill"]
    meta = {"AttachableRef": [{"EntityRef": {"type": "Bill", "value": bill["Id"]}}], "FileName": filename[:100],
            "ContentType": mime}
    files = {"file_metadata_01": (None, json.dumps(meta), "application/json"),
             "file_content_01": (filename[:100], original, mime)}
    _api(db, c, "POST", "upload", files=files)
    record.external = {**(record.external or {}), "qbo_id": bill["Id"], "qbo_type": "Bill"}
    return {"quickbooks_bill_id": bill["Id"]}


def verify_webhook(payload: bytes, signature: str | None) -> bool:
    token = _s.qbo_webhook_verifier_token.get_secret_value() if _s.qbo_webhook_verifier_token else ""
    if not token or not signature:
        return False
    good = base64.b64encode(hmac.new(token.encode(), payload, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(good, signature)


def due_for_poll(c, every_minutes: int = 5) -> bool:
    return c.status == "connected" and (not c.last_sync_at or c.last_sync_at < datetime.now(UTC) - timedelta(minutes=every_minutes))
