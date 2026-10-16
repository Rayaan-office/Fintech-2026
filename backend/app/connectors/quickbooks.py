"""Accounting software: QuickBooks Online sandbox company (UK). Accounting scope only.

We read customers, suppliers, payment terms, invoices, bills and payments. We write only after a
person approves (level 3): a bill, with its original document attached.

We have no public address (no tunnel), so the background schedule (app/scheduler.py) reads
QuickBooks' change feed every few minutes. The feed only goes back 30 days and stops at 1,000
changes per type, so when it is older or cut short we read everything instead. Signed
notifications also work when a public address is available.

Intuit replaces the refresh token on every refresh. A refreshed token is saved at once, in its
own transaction, so a sync that fails afterwards can't lose it.
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import tenant_session
from ..models import Connection, Counterparty, Record
from ..pipeline.counterparties import find_or_create
from . import outbound
from .common import get_connection, load_secret, mark_synced, route, save_secret, upsert_record

_s = get_settings()
AUTH_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
API = {"sandbox": "https://sandbox-quickbooks.api.intuit.com", "production": "https://quickbooks.api.intuit.com"}[
    _s.qbo_environment]
MINOR_VERSION = "75"
PAGE_SIZE = 1000
MAX_ROWS = 20_000  # per type; a small business has far fewer
CDC_LIMIT = 1000  # QuickBooks sends at most this many changes per type, with no paging
CDC_DAYS = 29  # it keeps changes for 30 days
OVERLAP = timedelta(minutes=5)  # each read starts a little before the last one ended
READ = ["Term", "Customer", "Vendor", "Invoice", "Bill", "Payment", "BillPayment", "Purchase"]
# QuickBooks type -> (our kind, direction, who it is with, which field names them)
TXN = {
    "Invoice": ("invoice", "in", "customer", "CustomerRef"),
    "Bill": ("bill", "out", "supplier", "VendorRef"),
    "Payment": ("payment_in", "in", "customer", "CustomerRef"),
    "BillPayment": ("payment_out", "out", "supplier", "VendorRef"),
    "Purchase": ("payment_out", "out", "supplier", "EntityRef"),
}
# The person has to sign in with Intuit again; retrying won't help
EXPIRED = {"invalid_grant", "UNAUTHORIZED"}
REALM = re.compile(r"^[0-9]{1,20}$")

_transport: httpx.BaseTransport | None = None  # tests put a fake QuickBooks here

QboId = Annotated[str, Field(pattern=r"^[0-9]{1,20}$")]
Money = Annotated[Decimal, Field(ge=-1_000_000_000, le=1_000_000_000)]


class QBOError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}")
        self.code = code

    @property
    def expired(self) -> bool:
        return self.code in EXPIRED

    def for_person(self) -> str:
        if self.code == "NOT_CONNECTED":
            return "Connect the accounting software first."
        if self.expired:
            return "The QuickBooks connection has expired. Reconnect."
        if self.code in ("invalid_client", "NOT_CONFIGURED"):
            return "QuickBooks didn't accept our app keys. Check the QuickBooks settings."
        if self.code == "RATE_LIMITED":
            return "QuickBooks asked us to slow down. We'll try again shortly."
        if self.code == "NOT_UK":
            return "This QuickBooks company isn't a UK company, so its amounts aren't in pounds."
        return "QuickBooks didn't respond. Try again in a minute."


class Token(BaseModel, extra="ignore"):
    access_token: str = Field(min_length=10, max_length=4000)
    refresh_token: str = Field(min_length=10, max_length=500)
    expires_in: int = Field(3600, ge=60, le=86_400)
    x_refresh_token_expires_in: int = Field(8_640_000, ge=0)


class Ref(BaseModel, extra="ignore"):
    value: str = Field(max_length=50)
    name: str | None = Field(None, max_length=300)
    type: str | None = Field(None, max_length=30)


class Term(BaseModel, extra="ignore"):
    Id: QboId
    DueDays: int | None = Field(None, ge=0, le=3650)


class Party(BaseModel, extra="ignore"):
    Id: QboId
    DisplayName: str = Field(min_length=1, max_length=300)
    PrimaryEmailAddr: dict | None = None
    SalesTermRef: Ref | None = None
    TermRef: Ref | None = None


class Linked(BaseModel, extra="ignore"):
    TxnId: QboId
    TxnType: str = Field(max_length=30)


class TxnLine(BaseModel, extra="ignore"):
    Amount: Money = Decimal(0)
    Description: str | None = Field(None, max_length=4000)
    DetailType: str | None = Field(None, max_length=60)
    LinkedTxn: list[Linked] = []
    AccountBasedExpenseLineDetail: dict | None = None


class Txn(BaseModel, extra="ignore"):
    Id: QboId
    TxnDate: date
    DueDate: date | None = None
    TotalAmt: Money = Decimal(0)
    Balance: Money | None = None
    CurrencyRef: Ref | None = None
    DocNumber: str | None = Field(None, max_length=30)
    PaymentRefNum: str | None = Field(None, max_length=30)
    CustomerRef: Ref | None = None
    VendorRef: Ref | None = None
    EntityRef: Ref | None = None
    Credit: bool | None = None
    Line: list[TxnLine] = []
    TxnTaxDetail: dict | None = None


def _pence(v) -> int:
    return int((Decimal(str(v or 0)) * 100).quantize(Decimal(1), ROUND_HALF_UP))


def _pounds(minor: int) -> float:
    return round(minor / 100, 2)


def _client(timeout: float) -> httpx.Client:
    return outbound.client(timeout=timeout, **({"transport": _transport} if _transport else {}))


def _json(r: httpx.Response):
    try:
        return json.loads(r.text, parse_float=Decimal)  # exact pence, no float rounding
    except ValueError:
        return None


def _lock(db: Session, business_id) -> None:
    """One QuickBooks sync or write per business at a time, across all our processes."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"quickbooks:{business_id}"})


# ── Sign-in with Intuit (OAuth 2.0) ────────────────────────────────────────


def _mac(raw: str) -> str:
    return hmac.new(_s.session_secret.get_secret_value().encode(), raw.encode(), hashlib.sha256).hexdigest()


def authorize_url(business_id, user_id) -> tuple[str, str]:
    """The Intuit sign-in address, and a one-time value the browser keeps in a cookie. The
    callback must bring back both, so a stolen or replayed address is useless."""
    nonce = secrets.token_urlsafe(18)
    raw = base64.urlsafe_b64encode(json.dumps({"b": str(business_id), "u": str(user_id), "n": nonce,
                                               "exp": int(time.time()) + 600}, separators=(",", ":")).encode()).decode()
    url = AUTH_URL + "?" + urlencode({"client_id": _s.qbo_client_id, "response_type": "code", "scope": _s.qbo_scopes,
                                      "redirect_uri": _s.qbo_redirect_uri, "state": f"{raw}.{_mac(raw)}"})
    return url, nonce


def check_state(state: str, nonce: str | None) -> tuple[str, str]:
    raw, _, mac = state.partition(".")
    if not hmac.compare_digest(mac, _mac(raw)):
        raise ValueError("bad state")
    data = json.loads(base64.urlsafe_b64decode(raw))
    if data["exp"] < time.time():
        raise ValueError("expired state")
    if not nonce or not hmac.compare_digest(str(data["n"]), nonce):
        raise ValueError("state from another browser")
    return data["b"], data["u"]


def _keys() -> tuple[str, str]:
    secret = _s.qbo_client_secret.get_secret_value() if _s.qbo_client_secret else ""
    if not _s.qbo_client_id or not secret:
        raise QBOError("NOT_CONFIGURED", "QBO_CLIENT_ID and QBO_CLIENT_SECRET are not set")
    return _s.qbo_client_id, secret


def _token_request(data: dict) -> dict:
    with _client(20) as http:
        r = http.post(TOKEN_URL, data=data, auth=_keys(), headers={"Accept": "application/json"})
    body = _json(r)
    if r.status_code != 200:
        code = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), str) else None
        raise QBOError(code or str(r.status_code), "token request refused")
    try:
        t = Token.model_validate(body)
    except ValidationError:
        raise QBOError("BAD_TOKEN", "unexpected token answer") from None
    now = time.time()
    return {"access_token": t.access_token, "refresh_token": t.refresh_token, "expires_at": now + t.expires_in - 120,
            "refresh_expires_at": now + t.x_refresh_token_expires_in}


def _revoke(refresh_token: str) -> None:
    try:
        with _client(15) as http:
            http.post(REVOKE_URL, json={"token": refresh_token}, auth=_keys(), headers={"Accept": "application/json"})
    except (httpx.HTTPError, QBOError, outbound.OutboundRefused):
        pass  # we forget the token either way


def finish_connect(db: Session, business_id, code: str, realm_id: str) -> None:
    """Swap the sign-in code for tokens. Run a full sync afterwards."""
    if not REALM.match(realm_id or ""):
        raise QBOError("BAD_REALM", "unexpected company id")
    _lock(db, business_id)
    t = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": _s.qbo_redirect_uri})
    c = get_connection(db, business_id, "quickbooks")
    old = load_secret(c)
    route(db, "quickbooks", realm_id, business_id)
    if old.get("realm_id") and old["realm_id"] != realm_id:
        # Another company: its ids mean nothing in the new one. Its records are voided by the full sync.
        _revoke(old["refresh_token"])
        for cp in db.execute(select(Counterparty)).scalars():
            if "quickbooks" in (cp.external_ids or {}):
                cp.external_ids = {k: v for k, v in cp.external_ids.items() if k != "quickbooks"}
    save_secret(c, {**t, "realm_id": realm_id})
    c.status = "connected"
    c.last_error = None
    c.cursor = None
    c.meta = {"realm_id": realm_id, "mode": _s.qbo_environment}
    db.flush()


def disconnect(db: Session, business_id) -> None:
    c = get_connection(db, business_id, "quickbooks")
    secret = load_secret(c)
    if secret.get("refresh_token"):
        _revoke(secret["refresh_token"])
    c.token_enc = None
    c.cursor = None
    c.status = "disconnected"
    c.meta = {k: v for k, v in (c.meta or {}).items() if k in ("realm_id", "mode")}


# ── Calls to one connected company ─────────────────────────────────────────


class Books:
    """Calls to the business's QuickBooks company. Refreshes the sign-in when it runs out."""

    def __init__(self, db: Session, business_id):
        self.c = get_connection(db, business_id, "quickbooks")
        self.sec = load_secret(self.c)
        if not self.sec or self.c.status == "disconnected":
            raise QBOError("NOT_CONNECTED")
        self.realm = self.sec["realm_id"]

    def _refresh(self) -> None:
        t = _token_request({"grant_type": "refresh_token", "refresh_token": self.sec["refresh_token"]})
        self.sec = {**self.sec, **t}
        save_secret(self.c, self.sec)
        # Kept even if what we are doing now fails and is rolled back: the old token no longer works
        with tenant_session(self.c.business_id) as db:
            db.execute(text("SET LOCAL lock_timeout = '5s'"))
            row = db.get(Connection, self.c.id)
            if row:
                save_secret(row, self.sec)

    def call(self, method: str, path: str, *, params: dict | None = None, json_body: dict | None = None,
             files: dict | None = None, _again: bool = True) -> dict:
        if self.sec.get("expires_at", 0) < time.time():
            self._refresh()
        headers = {"Authorization": f"Bearer {self.sec['access_token']}", "Accept": "application/json"}
        with _client(30) as http:
            r = http.request(method, f"{API}/v3/company/{self.realm}/{path}",
                             params={"minorversion": MINOR_VERSION, **(params or {})},
                             headers=headers, json=json_body, files=files)
        if r.status_code == 401 and _again:  # signed out early (for example the token was revoked)
            self._refresh()
            return self.call(method, path, params=params, json_body=json_body, files=files, _again=False)
        body = _json(r)
        if r.status_code == 401:
            raise QBOError("UNAUTHORIZED", "signed out")
        if r.status_code == 429:
            raise QBOError("RATE_LIMITED", "too many requests")
        if r.status_code >= 500 or not isinstance(body, dict):
            raise QBOError("UNAVAILABLE", f"answered {r.status_code}")
        if r.status_code >= 400 or "Fault" in body:
            err = ((body.get("Fault") or {}).get("Error") or [{}])[0]
            raise QBOError(str(err.get("code") or r.status_code), str(err.get("Detail") or err.get("Message") or "")[:200])
        return body

    def query(self, entity: str, where: str = "") -> list[dict]:
        out, start = [], 1
        while True:
            q = f"select * from {entity}{where} startposition {start} maxresults {PAGE_SIZE}"
            rows = self.call("GET", "query", params={"query": q}).get("QueryResponse", {}).get(entity, [])
            out.extend(rows)
            if len(rows) < PAGE_SIZE:
                return out
            if len(out) >= MAX_ROWS:
                raise QBOError("TOO_MANY", f"more than {MAX_ROWS} {entity} rows")
            start += PAGE_SIZE

    def changes(self, since: str) -> dict[str, list] | None:
        """What changed since then, or None if QuickBooks cut the list short."""
        resp = self.call("GET", "cdc", params={"entities": ",".join(READ), "changedSince": since})
        data: dict[str, list] = {e: [] for e in READ}
        for block in ((resp.get("CDCResponse") or [{}])[0].get("QueryResponse") or []):
            for e in READ:
                data[e].extend(block.get(e, []))
        return None if any(len(rows) >= CDC_LIMIT for rows in data.values()) else data

    def company(self) -> dict:
        """Country and home currency."""
        info = self.call("GET", f"companyinfo/{self.realm}").get("CompanyInfo", {})
        prefs = self.call("GET", "preferences").get("Preferences", {})
        currency = ((prefs.get("CurrencyPrefs") or {}).get("HomeCurrency") or {}).get("value")
        return {"country": str(info.get("Country") or "")[:10], "currency": currency or "GBP"}


# ── Reading ────────────────────────────────────────────────────────────────


def _account_ref(t: Txn) -> dict:
    for line in t.Line:
        ref = (line.AccountBasedExpenseLineDetail or {}).get("AccountRef") or {}
        if ref.get("value"):
            return ref
    return {}


def _category(t: Txn) -> str | None:
    name = str(_account_ref(t).get("name") or "")
    return name.split(":")[-1].strip().lower()[:80] or None


def _values(entity: str, t: Txn, realm: str, currency: str, cp: Counterparty | None) -> dict:
    kind, direction, _, _ = TXN[entity]
    total, balance = _pence(t.TotalAmt), _pence(t.Balance)
    ccy = t.CurrencyRef.value if t.CurrencyRef and re.fullmatch(r"[A-Z]{3}", t.CurrencyRef.value) else currency
    if entity == "Purchase" and t.Credit:  # a refund from a supplier
        kind, direction = "refund", "in"
    if total == 0:
        status = "void"  # QuickBooks keeps voided transactions with their amounts set to zero
    elif kind in ("invoice", "bill"):
        status = "open" if balance > 0 else "paid"
    else:
        status = "posted"
    ref = t.DocNumber or t.PaymentRefNum
    label = {"Invoice": "Invoice", "Bill": "Bill", "Payment": "Customer payment", "BillPayment": "Bill payment",
             "Purchase": "Purchase"}[entity]
    lines = [{"description": (ln.Description or "")[:200], "amount_minor": _pence(ln.Amount)} for ln in t.Line
             if ln.DetailType and ln.DetailType.endswith("LineDetail") and ln.DetailType != "SubTotalLineDetail"]
    return {
        "kind": kind, "direction": direction, "amount_minor": total,
        "open_minor": balance if kind in ("invoice", "bill") and status == "open" else 0,
        "currency": ccy, "date": t.TxnDate, "due_date": t.DueDate, "status": status,
        "counterparty_id": cp.id if cp else None, "reference": ref,
        "description": f"{label} {ref or ''}".strip()[:500],
        "category": "sales" if direction == "in" and kind != "refund" else _category(t),
        "tax_minor": _pence((t.TxnTaxDetail or {}).get("TotalTax")) if t.TxnTaxDetail else None,
        "lines": lines[:200],
        "external": {"qbo_id": t.Id, "qbo_type": entity, "realm": realm,
                     "linked": sorted({f"{lt.TxnType}:{lt.TxnId}" for ln in t.Line for lt in ln.LinkedTxn}),
                     "account": str(_account_ref(t).get("value") or "")[:20] or None},
    }


def _same(r: Record, values: dict) -> bool:
    """Nothing to update. An open item's unpaid amount only counts if it went down: our own
    matching may already have settled part of it (see upsert_record)."""
    still_open = values["status"] == "open" and values["open_minor"] >= r.open_minor
    return all(getattr(r, k) == v for k, v in values.items() if k != "open_minor") and (
        still_open or r.open_minor == values["open_minor"])


def sync(db: Session, business_id, full: bool = False) -> dict:
    """Read what changed (or everything) into our records."""
    _lock(db, business_id)
    books = Books(db, business_id)
    c, realm = books.c, books.realm
    meta = dict(c.meta or {})
    started = datetime.now(UTC) - OVERLAP
    since = meta.get("cdc_since")
    data = None
    if not full and since and datetime.fromisoformat(since) > datetime.now(UTC) - timedelta(days=CDC_DAYS):
        data = books.changes(since)
    full = data is None
    if full:
        data = {e: books.query(e) for e in READ}
    if not meta.get("currency"):
        meta.update(books.company())
    currency = meta["currency"]
    counts = {"customers": 0, "suppliers": 0, "added": 0, "changed": 0, "removed": 0, "skipped": 0}

    terms = dict(meta.get("terms") or {})
    for row in data["Term"]:
        try:
            t = Term.model_validate(row)
        except ValidationError:
            counts["skipped"] += 1
            continue
        terms[t.Id] = t.DueDays

    known = {(cp.kind, (cp.external_ids or {}).get("quickbooks")): cp for cp in db.execute(select(Counterparty)).scalars()
             if (cp.external_ids or {}).get("quickbooks")}
    for kind, entity in (("customer", "Customer"), ("supplier", "Vendor")):
        for row in data[entity]:
            if row.get("status") == "Deleted":
                continue
            try:
                p = Party.model_validate(row)
            except ValidationError:
                counts["skipped"] += 1
                continue
            cp = known.get((kind, p.Id))
            if not cp:
                cp, _ = find_or_create(db, business_id, kind, p.DisplayName)
                cp.external_ids = {**(cp.external_ids or {}), "quickbooks": p.Id}
                known[(kind, p.Id)] = cp
            address = str((p.PrimaryEmailAddr or {}).get("Address") or "")
            if "@" in address and not cp.email_domain:
                cp.email_domain = address.rsplit("@", 1)[1].lower()[:253]
            term = p.SalesTermRef or p.TermRef
            if term and terms.get(term.value) is not None:
                cp.payment_terms_days = terms[term.value]
            counts["customers" if kind == "customer" else "suppliers"] += 1

    existing = {r.source_ref: r for r in db.execute(select(Record).where(Record.source == "quickbooks")).scalars()}
    # Bills we added ourselves after approval already have a record (from the document): keep one
    ours = {f"{r.external['realm']}:{r.external['qbo_type']}:{r.external['qbo_id']}": r for r in db.execute(
        select(Record).where(Record.source != "quickbooks", Record.external.has_key("qbo_id"))).scalars()
        if r.external.get("realm")}
    seen: set[str] = set()
    for entity, (_, _, party_kind, party_field) in TXN.items():
        for row in data[entity]:
            ref = f"{realm}:{entity}:{row.get('Id')}"
            if row.get("status") == "Deleted":
                r = existing.get(ref)
                if r and r.status != "void":
                    r.status, r.open_minor = "void", 0
                    counts["removed"] += 1
                continue
            seen.add(ref)  # even if we can't read it: it still exists
            try:
                t = Txn.model_validate(row)
            except ValidationError:
                counts["skipped"] += 1
                continue
            if ref in ours:
                r = ours[ref]
                paid_down = _pence(t.Balance)
                if r.status == "open" and paid_down < r.open_minor:  # paid (partly) in QuickBooks
                    r.open_minor = paid_down
                    r.status = "open" if paid_down else "paid"
                    counts["changed"] += 1
                continue
            who = getattr(t, party_field)
            cp = known.get((party_kind, who.value)) if who and who.type in (None, "Vendor", "Customer") else None
            values = _values(entity, t, realm, currency, cp)
            r = existing.get(ref)
            if r and _same(r, values):
                continue
            upsert_record(db, business_id, "quickbooks", ref, **values)
            counts["changed" if r else "added"] += 1

    if full:  # anything we hold that QuickBooks no longer has was deleted (or is from another company)
        for ref, r in existing.items():
            if ref not in seen and r.status != "void":
                r.status, r.open_minor = "void", 0
                counts["removed"] += 1

    meta.update(cdc_since=started.isoformat(timespec="seconds"), terms=terms, last_read="full" if full else "changes")
    c.meta = meta
    db.flush()
    mark_synced(db, c, counts)
    return counts


# ── Writing (only after approval) ──────────────────────────────────────────


def _q(value: str) -> str:
    """A value inside a QuickBooks query: quotes escaped, nothing that could end the string."""
    return value.replace("\\", "").replace("'", "\\'")


def _name(value: str) -> str:
    return re.sub(r"[\x00-\x1f:]", " ", value).strip()[:100] or "Supplier"


def _vendor_id(books: Books, cp: Counterparty) -> str:
    vid = (cp.external_ids or {}).get("quickbooks")
    if vid:
        return vid
    name = _name(cp.display_name)
    found = books.query("Vendor", f" where DisplayName = '{_q(name)}'")
    if found:
        vid = found[0]["Id"]
    else:
        try:
            vid = books.call("POST", "vendor", json_body={"DisplayName": name})["Vendor"]["Id"]
        except QBOError as e:
            if e.code != "6240":  # the name is taken by a customer or employee
                raise
            vid = books.call("POST", "vendor", json_body={"DisplayName": f"{name[:89]} (supplier)"})["Vendor"]["Id"]
    cp.external_ids = {**(cp.external_ids or {}), "quickbooks": vid}
    return vid


def _usual_account(db: Session, cp: Counterparty, realm: str) -> str | None:
    """The account this supplier's latest bill in QuickBooks went to, so new ones go there too."""
    rows = db.execute(select(Record).where(Record.source == "quickbooks", Record.kind == "bill",
                                           Record.counterparty_id == cp.id).order_by(Record.date.desc())).scalars()
    for r in rows:
        if (r.external or {}).get("realm") == realm and r.external.get("account"):
            return r.external["account"]
    return None


def _expense_account(books: Books, category: str | None) -> str:
    accounts = [a for a in books.query("Account", " where Active = true")
                if a.get("AccountType") in ("Expense", "Cost of Goods Sold")]
    if not accounts:
        raise QBOError("NO_EXPENSE_ACCOUNT", "no expense account in QuickBooks")
    wanted = [category] if category else []
    for want in [*wanted, "purchases", "cost of sales", "supplies", "general"]:
        for a in accounts:
            if want and want.lower() in str(a.get("Name", "")).lower():
                return a["Id"]
    return accounts[0]["Id"]


def tax_code(books: Books, net: int, tax: int, side: str = "Purchase") -> str | None:
    """The VAT code whose purchase (or sales) rate matches, e.g. 20.0% S. None outside VAT countries."""
    rates = {r["Id"]: Decimal(str(r.get("RateValue", 0))) for r in books.query("TaxRate")}
    if not rates:
        return None
    rate = (Decimal(tax) * 100 / Decimal(net)).quantize(Decimal("0.1"), ROUND_HALF_UP) if net else Decimal(0)
    best = None
    for code in books.query("TaxCode", " where Active = true"):
        details = (code.get(f"{side}TaxRateList") or {}).get("TaxRateDetail") or []
        code_rates = [rates.get((d.get("TaxRateRef") or {}).get("value")) for d in details]
        if len(code_rates) == 1 and code_rates[0] is not None and abs(code_rates[0] - rate) <= Decimal("0.6"):
            plain = str(code.get("Name", "")).endswith((" S", " R", " Z"))  # standard, reduced, zero; not reverse charge
            if plain or best is None:
                best = code["Id"]
            if plain:
                break
    if best is None:
        raise QBOError("NO_TAX_CODE", f"no {side.lower()} VAT code at {rate}%")
    return best


def post_bill(db: Session, business_id, record: Record, original: bytes, filename: str, mime: str,
              request_key: str) -> dict:
    """Add an approved bill with its original attached. request_key makes a retry safe: QuickBooks
    returns the bill it already made instead of making a second one."""
    _lock(db, business_id)
    books = Books(db, business_id)
    if (record.external or {}).get("qbo_type") == "Bill":
        return {"quickbooks_bill_id": record.external["qbo_id"], "already_posted": True}
    cp = db.get(Counterparty, record.counterparty_id) if record.counterparty_id else None
    if not cp:
        raise QBOError("NO_SUPPLIER", "the bill has no supplier")
    currency = (books.c.meta or {}).get("currency") or "GBP"
    if record.currency != currency:
        raise QBOError("CURRENCY", f"the bill is in {record.currency}, the company in {currency}")
    tax = record.tax_minor or 0
    net = record.amount_minor - tax
    code = tax_code(books, net, tax)
    account = _usual_account(db, cp, books.realm) or _expense_account(books, record.category)
    detail = {"AccountRef": {"value": account}}
    if code:
        detail["TaxCodeRef"] = {"value": code}
    body = {
        "VendorRef": {"value": _vendor_id(books, cp)},
        "TxnDate": record.date.isoformat(),
        "Line": [{"DetailType": "AccountBasedExpenseLineDetail", "Amount": _pounds(net),
                  "Description": (record.description or record.reference or "")[:4000],
                  "AccountBasedExpenseLineDetail": detail}],
    }
    if code:
        body["GlobalTaxCalculation"] = "TaxExcluded"
        body["TxnTaxDetail"] = {"TotalTax": _pounds(tax)}
    if record.due_date:
        body["DueDate"] = record.due_date.isoformat()
    if record.reference:
        body["DocNumber"] = record.reference[:21]
    bill = books.call("POST", "bill", params={"requestid": f"{request_key}-bill"[:50]}, json_body=body)["Bill"]
    meta = {"AttachableRef": [{"EntityRef": {"type": "Bill", "value": bill["Id"]}}],
            "FileName": filename[:100], "ContentType": mime}
    files = {"file_metadata_01": (None, json.dumps(meta), "application/json"),
             "file_content_01": (filename[:100], original, mime)}
    up = books.call("POST", "upload", params={"requestid": f"{request_key}-file"[:50]}, files=files)
    attached = (((up.get("AttachableResponse") or [{}])[0]).get("Attachable") or {}).get("Id")
    record.external = {**(record.external or {}), "qbo_id": bill["Id"], "qbo_type": "Bill", "realm": books.realm}
    return {"quickbooks_bill_id": bill["Id"], "attachment_id": attached, "total_minor": _pence(bill.get("TotalAmt"))}


# ── Notifications (need a public address) ──────────────────────────────────


def verify_webhook(payload: bytes, signature: str | None) -> bool:
    token = _s.qbo_webhook_verifier_token.get_secret_value() if _s.qbo_webhook_verifier_token else ""
    if not token or not signature:
        return False
    good = base64.b64encode(hmac.new(token.encode(), payload, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(good, signature)


def notices(payload) -> list[tuple[str, str]]:
    """(notification id, company id) pairs, from the current format (a list of CloudEvents) or the
    older one ({"eventNotifications": [...]})."""
    out: list[tuple[str, str]] = []
    if isinstance(payload, list):
        for ev in payload[:50]:
            if isinstance(ev, dict) and REALM.match(str(ev.get("intuitaccountid", ""))) and ev.get("id"):
                out.append((str(ev["id"])[:200], str(ev["intuitaccountid"])))
    elif isinstance(payload, dict):
        for note in (payload.get("eventNotifications") or [])[:50]:
            realm = str(note.get("realmId", "")) if isinstance(note, dict) else ""
            if REALM.match(realm):
                digest = hashlib.sha256(json.dumps(note, sort_keys=True, default=str).encode()).hexdigest()
                out.append((digest, realm))
    return out
