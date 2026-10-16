"""The accounting connector (QuickBooks Online), against a fake QuickBooks that answers in the
shapes the real sandbox uses. The live contract test (tests/backend/contract) checks those shapes."""

import base64
import hashlib
import hmac
import json
import re
import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from tests.backend.conftest import PASSWORD, people

from app import actions, archive, scheduler
from app.connectors import quickbooks
from app.db import tenant_session
from app.models import Action, AuditEntry, Connection, Counterparty, Document, Record
from app.pipeline.counterparties import find_or_create
from app.seed import create_business

TODAY = date.today()
VERIFIER = "test-verifier-token"


def _d(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


def story_rows() -> dict[str, dict[str, dict]]:
    """A small UK company: two customers, one supplier, invoices, a bill and payments."""
    rows = {
        "Term": [{"Id": "3", "Name": "Net 14", "DueDays": 14}, {"Id": "4", "Name": "Net 30", "DueDays": 30}],
        "Customer": [
            {"Id": "1", "DisplayName": "Station Coffee Co", "SalesTermRef": {"value": "3"},
             "PrimaryEmailAddr": {"Address": "accounts@stationcoffee.example"}},
            {"Id": "2", "DisplayName": "Bright Cafe", "SalesTermRef": {"value": "3"}},
        ],
        "Vendor": [{"Id": "31", "DisplayName": "Acme Supplies Ltd", "TermRef": {"value": "4"},
                    "PrimaryEmailAddr": {"Address": "accounts@acme-supplies.co.uk"}}],
        "Invoice": [
            {"Id": "101", "DocNumber": "INV-2001", "TxnDate": _d(-40), "DueDate": _d(-26), "TotalAmt": 1450.80,
             "Balance": 0, "CustomerRef": {"value": "1", "name": "Station Coffee Co"},
             "CurrencyRef": {"value": "GBP"}, "TxnTaxDetail": {"TotalTax": 241.80},
             "Line": [{"Amount": 1209.00, "DetailType": "SalesItemLineDetail", "Description": "Sourdough loaves"},
                      {"Amount": 1209.00, "DetailType": "SubTotalLineDetail"}]},
            {"Id": "102", "DocNumber": "INV-2002", "TxnDate": _d(-11), "DueDate": _d(3), "TotalAmt": 422.40,
             "Balance": 422.40, "CustomerRef": {"value": "2"}, "CurrencyRef": {"value": "GBP"},
             "TxnTaxDetail": {"TotalTax": 70.40},
             "Line": [{"Amount": 352.00, "DetailType": "SalesItemLineDetail", "Description": "Croissants"}]},
        ],
        "Bill": [{"Id": "201", "DocNumber": "AS-980", "TxnDate": _d(-20), "DueDate": _d(10), "TotalAmt": 651.00,
                  "Balance": 651.00, "VendorRef": {"value": "31"}, "CurrencyRef": {"value": "GBP"},
                  "TxnTaxDetail": {"TotalTax": 108.50},
                  "Line": [{"Amount": 542.50, "DetailType": "AccountBasedExpenseLineDetail",
                            "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "60", "name": "Cost of sales:Stock"}}}]}],
        "Payment": [{"Id": "301", "TxnDate": _d(-25), "TotalAmt": 1450.80, "PaymentRefNum": "INV-2001",
                     "CustomerRef": {"value": "1"}, "CurrencyRef": {"value": "GBP"},
                     "Line": [{"Amount": 1450.80, "LinkedTxn": [{"TxnId": "101", "TxnType": "Invoice"}]}]}],
        "BillPayment": [],
        "Purchase": [{"Id": "401", "TxnDate": _d(-5), "TotalAmt": 59.88, "PaymentType": "CreditCard",
                      "EntityRef": {"value": "31", "type": "Vendor"}, "CurrencyRef": {"value": "GBP"},
                      "Line": [{"Amount": 49.90, "DetailType": "AccountBasedExpenseLineDetail",
                                "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "61", "name": "Software"}}}]}],
        "Account": [{"Id": "62", "Name": "Purchases", "AccountType": "Expense", "Active": True},
                    {"Id": "60", "Name": "Cost of sales", "AccountType": "Cost of Goods Sold", "Active": True},
                    {"Id": "61", "Name": "Software", "AccountType": "Expense", "Active": True}],
        "TaxRate": [{"Id": "10", "Name": "20.0% S (Purchase)", "RateValue": 20},
                    {"Id": "11", "Name": "20.0% RC (Purchase)", "RateValue": 20},
                    {"Id": "12", "Name": "0.0% Z (Purchase)", "RateValue": 0}],
        "TaxCode": [  # reverse charge first, so picking the plain standard rate is tested
            {"Id": "20", "Name": "20.0% RC", "Active": True,
             "PurchaseTaxRateList": {"TaxRateDetail": [{"TaxRateRef": {"value": "11"}}]}},
            {"Id": "21", "Name": "20.0% S", "Active": True,
             "PurchaseTaxRateList": {"TaxRateDetail": [{"TaxRateRef": {"value": "10"}}]}},
            {"Id": "22", "Name": "0.0% Z", "Active": True,
             "PurchaseTaxRateList": {"TaxRateDetail": [{"TaxRateRef": {"value": "12"}}]}},
        ],
    }
    return {e: {r["Id"]: r for r in rs} for e, rs in rows.items()}


class FakeQuickBooks:
    """Companies with rows and a change log. Like the real one, refresh tokens are replaced on
    every refresh and the old one stops working."""

    def __init__(self):
        self.companies: dict[str, dict] = {}
        self.codes: dict[str, str] = {}
        self.refresh: dict[str, str] = {}  # refresh token -> company
        self.access: dict[str, str] = {}  # access token -> company
        self.revoked: list[str] = []
        self.calls: list[tuple[str, str]] = []
        self.failures: list[tuple[str, int, dict | None]] = []  # (path contains, status, body), each once
        self.requests: dict[str, dict] = {}  # requestid -> answer already given
        self.posted: list[dict] = []
        self.uploads: list[bytes] = []
        self.expires_in = 3600
        self.during_read = None  # (type, fn): fn runs once, while a full read reads that type
        self._next = 5000

    # ── test controls
    def company(self, country: str = "GB", currency: str = "GBP") -> str:
        realm = str(uuid.uuid4().int)[:16]
        now = datetime.now(UTC)
        rows = story_rows()
        self.companies[realm] = {"rows": rows, "country": country, "currency": currency, "deleted": [],
                                 "changed": {(e, i): now for e, rs in rows.items() for i in rs}}
        return realm

    def code_for(self, realm: str) -> str:
        code = f"code-{uuid.uuid4().hex}"
        self.codes[code] = realm
        return code

    def change(self, realm: str, entity: str, id_: str, **fields) -> None:
        co = self.companies[realm]
        co["rows"][entity].setdefault(id_, {"Id": id_}).update(fields)
        co["changed"][(entity, id_)] = datetime.now(UTC)

    def delete(self, realm: str, entity: str, id_: str) -> None:
        co = self.companies[realm]
        co["rows"][entity].pop(id_)
        co["deleted"].append((entity, id_, datetime.now(UTC)))

    def fail(self, path: str, status: int, body: dict | None = None) -> None:
        self.failures.append((path, status, body))

    def bills(self, realm: str) -> dict:
        return self.companies[realm]["rows"]["Bill"]

    # ── the fake service
    def _tokens(self, realm: str) -> dict:
        at, rt = f"at-{uuid.uuid4().hex}", f"rt-{uuid.uuid4().hex}"
        self.access[at], self.refresh[rt] = realm, realm
        return {"access_token": at, "refresh_token": rt, "token_type": "bearer", "expires_in": self.expires_in,
                "x_refresh_token_expires_in": 8_726_400}

    def _fault(self, status: int, code: str, detail: str = "") -> httpx.Response:
        return httpx.Response(status, json={"Fault": {"Error": [{"Message": detail, "Detail": detail, "code": code}],
                                                      "type": "ValidationFault"}})

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        self.calls.append((request.method, url.path))
        for i, (path, status, body) in enumerate(self.failures):
            if path in url.path:
                del self.failures[i]
                return httpx.Response(status, json=body) if body else httpx.Response(status, text="<html>busy</html>")
        if url.host == "oauth.platform.intuit.com":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if form["grant_type"] == "authorization_code":
                realm = self.codes.pop(form["code"], None)
                return httpx.Response(200, json=self._tokens(realm)) if realm else \
                    httpx.Response(400, json={"error": "invalid_grant"})
            realm = self.refresh.pop(form.get("refresh_token"), None)
            if not realm:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=self._tokens(realm))
        if url.host == "developer.api.intuit.com":
            self.revoked.append(json.loads(request.content)["token"])
            return httpx.Response(200)
        m = re.match(r"^/v3/company/(\d+)/(.+)$", url.path)
        realm, path = m.group(1), m.group(2)
        if self.access.get(request.headers.get("authorization", "").removeprefix("Bearer ")) != realm:
            return self._fault(401, "3200", "AuthenticationFailed")
        co = self.companies[realm]
        rows = co["rows"]
        rid = url.params.get("requestid")
        if rid and rid in self.requests:
            return httpx.Response(200, json=self.requests[rid])
        if path == "query":
            q = re.match(r"select \* from (\w+)(?: where (.+?))? startposition (\d+) maxresults (\d+)$",
                         url.params["query"])
            entity, where, start, size = q.group(1), q.group(2), int(q.group(3)), int(q.group(4))
            found = list(rows.get(entity, {}).values())
            if where and where.startswith("DisplayName = "):
                name = where.removeprefix("DisplayName = ").strip("'").replace("\\'", "'")
                found = [r for r in found if r.get("DisplayName") == name]
            if self.during_read and self.during_read[0] == entity:  # (after reading this type, do this)
                hook, self.during_read = self.during_read[1], None
                hook()
            return httpx.Response(200, json={"QueryResponse": {entity: found[start - 1:start - 1 + size]}})
        if path == "cdc":
            since = datetime.fromisoformat(url.params["changedSince"])
            out = []
            for e in url.params["entities"].split(","):
                got = [r for i, r in rows.get(e, {}).items() if co["changed"].get((e, i), since) > since]
                got += [{"Id": i, "status": "Deleted"} for de, i, t in co["deleted"] if de == e and t > since]
                if got:
                    out.append({e: got})
            return httpx.Response(200, json={"CDCResponse": [{"QueryResponse": out}]})
        if path == f"companyinfo/{realm}":
            return httpx.Response(200, json={"CompanyInfo": {"CompanyName": "Leeds Bakery", "Country": co["country"]}})
        if path == "preferences":
            return httpx.Response(200, json={"Preferences": {"CurrencyPrefs": {"HomeCurrency": {"value": co["currency"]}}}})
        if path == "vendor":
            name = json.loads(request.content)["DisplayName"]
            taken = {r["DisplayName"] for e in ("Customer", "Vendor") for r in rows[e].values()}
            if name in taken:
                return self._fault(400, "6240", "Duplicate Name Exists Error")
            self._next += 1
            rows["Vendor"][str(self._next)] = v = {"Id": str(self._next), "DisplayName": name}
            return httpx.Response(200, json={"Vendor": v})
        if path == "bill":
            body = json.loads(request.content)
            self.posted.append(body)
            self._next += 1
            net = sum(line["Amount"] for line in body["Line"])
            total = round(net + (body.get("TxnTaxDetail") or {}).get("TotalTax", 0), 2)
            bill = {**body, "Id": str(self._next), "TotalAmt": total, "Balance": total, "CurrencyRef": {"value": "GBP"}}
            self.change(realm, "Bill", bill["Id"], **bill)
            answer = {"Bill": bill}
        elif path == "upload":
            assert b'name="file_content_01"' in request.content and b'"AttachableRef"' in request.content
            self.uploads.append(request.content)
            answer = {"AttachableResponse": [{"Attachable": {"Id": f"att{len(self.uploads)}"}}]}
        else:
            raise AssertionError(f"unexpected QuickBooks call {request.method} {path}")
        if rid:
            self.requests[rid] = answer
        return httpx.Response(200, json=answer)


@pytest.fixture
def fake_qbo(monkeypatch):
    fake = FakeQuickBooks()
    monkeypatch.setattr(quickbooks, "_transport", httpx.MockTransport(fake.handle))
    monkeypatch.setattr(quickbooks._s, "qbo_client_id", "test-client")
    monkeypatch.setattr(quickbooks._s, "qbo_client_secret", SecretStr("test-secret"))
    monkeypatch.setattr(quickbooks._s, "qbo_webhook_verifier_token", SecretStr(VERIFIER))
    return fake


@pytest.fixture
def biz(businesses, sign_in):
    """A new business per test, so each starts with no accounting connection."""
    tag = f"books{uuid.uuid4().hex[:8]}"
    b = create_business(f"Business {tag}", people(tag), {e: PASSWORD for e, *_ in people(tag)}, inbox=f"bills@{tag}.test")
    return SimpleNamespace(id=b.id, tag=tag, finance=sign_in(f"finance@{tag}.test"), sign_in=sign_in)


def _start(client) -> str:
    r = client.get("/api/connections/quickbooks/start")
    assert r.status_code == 200, r.text
    return parse_qs(urlparse(r.json()["url"]).query)["state"][0]


def _connect(biz, fake, realm: str | None = None, client=None) -> str:
    """Sign in with Intuit and come back. Returns where the browser was sent."""
    client = client or biz.finance
    realm = realm or fake.company()
    state = _start(client)
    r = client.get("/connect/quickbooks/callback", params={"code": fake.code_for(realm), "state": state,
                                                            "realmId": realm}, follow_redirects=False)
    assert r.status_code == 303
    return r.headers["location"].split("qbo=")[1]


def _records(bid) -> dict[str, Record]:
    """QuickBooks records by type and id, e.g. "Invoice:101"."""
    with tenant_session(bid) as db:
        rows = db.execute(select(Record).where(Record.source == "quickbooks")).scalars().all()
        db.expunge_all()
    return {r.source_ref.split(":", 1)[1]: r for r in rows}


def _connection(bid) -> Connection:
    with tenant_session(bid) as db:
        c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one()
        db.expunge(c)
    return c


def _realm(bid) -> str:
    return _connection(bid).meta["realm_id"]


def _later(minutes: int) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


def _api_reads(fake, realm: str, kind: str) -> int:
    """Calls about this company only: the schedule also reads businesses from other tests."""
    return sum(1 for _, p in fake.calls if p == f"/v3/company/{realm}/{kind}")


# ── Signing in ─────────────────────────────────────────────────────────────


def test_connecting_reads_the_whole_company(fake_qbo, biz):
    assert _connect(biz, fake_qbo) == "connected"
    recs = _records(biz.id)
    assert set(recs) == {"Invoice:101", "Invoice:102", "Bill:201", "Payment:301", "Purchase:401"}
    paid, open_ = recs["Invoice:101"], recs["Invoice:102"]
    assert (paid.amount_minor, paid.open_minor, paid.status, paid.tax_minor) == (145080, 0, "paid", 24180)
    assert (open_.amount_minor, open_.open_minor, open_.status, open_.due_date) == (42240, 42240, "open",
                                                                                  TODAY + timedelta(days=3))
    assert paid.lines == [{"description": "Sourdough loaves", "amount_minor": 120900}]  # no subtotal line
    bill = recs["Bill:201"]
    assert (bill.kind, bill.direction, bill.open_minor, bill.category) == ("bill", "out", 65100, "stock")
    assert recs["Payment:301"].external["linked"] == ["Invoice:101"]
    assert recs["Purchase:401"].category == "software"
    with tenant_session(biz.id) as db:
        acme = db.execute(select(Counterparty).where(Counterparty.display_name == "Acme Supplies Ltd")).scalar_one()
        assert (acme.kind, acme.payment_terms_days, acme.email_domain) == ("supplier", 30, "acme-supplies.co.uk")
        assert acme.external_ids["quickbooks"] == "31"
        assert bill.counterparty_id == acme.id
    c = _connection(biz.id)
    assert c.status == "connected" and c.meta["currency"] == "GBP" and c.meta["country"] == "GB"
    assert c.meta["last_read"] == "full"
    assert "access_token" not in json.dumps(c.meta)


def test_sign_in_link_only_works_in_the_browser_that_asked_for_it(fake_qbo, biz):
    state = _start(biz.finance)
    other = biz.sign_in(f"finance@{biz.tag}.test")  # same person, another browser: no one-time cookie
    realm = fake_qbo.company()
    r = other.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                           "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=failed")
    assert _records(biz.id) == {}


def test_sign_in_link_from_another_person_is_refused(fake_qbo, biz):
    state = _start(biz.finance)
    owner = biz.sign_in(f"owner@{biz.tag}.test")
    owner.cookies.set(quickbooks_cookie(), biz.finance.cookies.get(quickbooks_cookie()), path="/connect/quickbooks")
    realm = fake_qbo.company()
    r = owner.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                           "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=failed")


def quickbooks_cookie() -> str:
    from app.api.connections import QBO_COOKIE

    return QBO_COOKIE


def test_cancelled_or_tampered_sign_in(fake_qbo, biz):
    state = _start(biz.finance)
    r = biz.finance.get("/connect/quickbooks/callback", params={"error": "access_denied", "state": state},
                        follow_redirects=False)
    assert r.headers["location"].endswith("qbo=cancelled")
    state = _start(biz.finance)
    raw, mac = state.split(".")
    realm = fake_qbo.company()
    r = biz.finance.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "realmId": realm,
                                                                 "state": f"{raw}.{'0' * len(mac)}"}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=failed")


def test_sign_in_link_goes_straight_to_intuit(fake_qbo, biz):
    r = biz.finance.get("/connect/quickbooks/start", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith(quickbooks.AUTH_URL)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    realm = fake_qbo.company()
    r = biz.finance.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                                 "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=connected")


def test_staff_cannot_connect(fake_qbo, biz):
    staff = biz.sign_in(f"staff@{biz.tag}.test")
    assert staff.get("/api/connections/quickbooks/start").status_code == 403
    assert staff.get("/connect/quickbooks/start", follow_redirects=False).status_code == 403


def test_one_company_belongs_to_one_business(fake_qbo, biz, businesses):
    realm = fake_qbo.company()
    assert _connect(biz, fake_qbo, realm) == "connected"
    tag = f"books{uuid.uuid4().hex[:8]}"
    create_business(f"Business {tag}", people(tag), {e: PASSWORD for e, *_ in people(tag)}, inbox=f"bills@{tag}.test")
    other = SimpleNamespace(finance=biz.sign_in(f"finance@{tag}.test"))
    assert _connect(other, fake_qbo, realm) == "taken"


def test_reconnecting_to_another_company_replaces_the_old_books(fake_qbo, biz):
    _connect(biz, fake_qbo)
    first = _realm(biz.id)
    assert _connect(biz, fake_qbo) == "connected"
    second = _realm(biz.id)
    with tenant_session(biz.id) as db:
        rows = db.execute(select(Record).where(Record.source == "quickbooks")).scalars().all()
        live = {r.source_ref for r in rows if r.status != "void"}
        assert live and all(ref.startswith(second) for ref in live)
        assert all(r.status == "void" for r in rows if r.source_ref.startswith(first))
    assert any(t.startswith("rt-") for t in fake_qbo.revoked)  # the first company's access was given back


def test_a_company_outside_the_uk_is_noted(fake_qbo, biz):
    _connect(biz, fake_qbo, fake_qbo.company(country="US", currency="USD"))
    c = _connection(biz.id)
    assert c.meta["currency"] == "USD"
    assert {r.currency for r in _records(biz.id).values()} == {"GBP"}  # each row says its own currency


# ── Keeping up to date ─────────────────────────────────────────────────────


def test_schedule_reads_only_what_changed(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    queries = _api_reads(fake_qbo, _realm(biz.id), "query")
    assert biz.id not in scheduler.poll_books(_later(5))  # not due yet
    fake_qbo.change(realm, "Invoice", "102", Balance=200.00)  # part-paid
    fake_qbo.change(realm, "Invoice", "103", DocNumber="INV-2003", TxnDate=_d(-1), DueDate=_d(13), TotalAmt=300.00,
                    Balance=300.00, CustomerRef={"value": "2"})
    fake_qbo.delete(realm, "Bill", "201")
    assert biz.id in scheduler.poll_books(_later(11))
    assert _api_reads(fake_qbo, _realm(biz.id), "query") == queries  # the change feed, not a full read
    recs = _records(biz.id)
    assert (recs["Invoice:102"].open_minor, recs["Invoice:102"].status) == (20000, "open")
    assert recs["Invoice:103"].amount_minor == 30000
    assert (recs["Bill:201"].status, recs["Bill:201"].open_minor) == ("void", 0)
    c = _connection(biz.id)
    assert c.meta["last_counts"]["added"] == 1 and c.meta["last_counts"]["changed"] == 1
    assert c.meta["last_counts"]["removed"] == 1 and c.meta["last_read"] == "changes"


def test_quiet_reads_are_not_logged(fake_qbo, biz):
    _connect(biz, fake_qbo)
    scheduler.poll_books(_later(11))  # the feed repeats the last few minutes: nothing new
    assert _connection(biz.id).meta["last_counts"] == {"customers": 2, "suppliers": 1, "added": 0, "changed": 0,
                                                       "removed": 0, "skipped": 0}
    with tenant_session(biz.id) as db:
        logged = db.execute(select(AuditEntry).where(AuditEntry.actor == "scheduler")).scalars().all()
    assert logged == []


def test_change_feed_too_old_reads_everything(fake_qbo, biz):
    _connect(biz, fake_qbo)
    with tenant_session(biz.id) as db:
        c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one()
        c.meta = {**c.meta, "cdc_since": (datetime.now(UTC) - timedelta(days=40)).isoformat(timespec="seconds")}
    cdc = _api_reads(fake_qbo, _realm(biz.id), "cdc")
    scheduler.poll_books(_later(11))
    assert _api_reads(fake_qbo, _realm(biz.id), "cdc") == cdc
    assert _connection(biz.id).meta["last_read"] == "full"


def test_change_feed_cut_short_reads_everything(fake_qbo, biz, monkeypatch):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    monkeypatch.setattr(quickbooks, "CDC_LIMIT", 2)
    fake_qbo.change(realm, "Invoice", "102", Balance=100.00)
    fake_qbo.change(realm, "Invoice", "101", PrivateNote="checked")
    scheduler.poll_books(_later(11))
    assert _connection(biz.id).meta["last_read"] == "full"
    assert _records(biz.id)["Invoice:102"].open_minor == 10000


def test_unreadable_rows_are_skipped_and_kept(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    fake_qbo.change(realm, "Invoice", "102", TotalAmt="lots")
    fake_qbo.change(realm, "Invoice", "104", DocNumber="X" * 500, TxnDate=_d(0), TotalAmt=5)
    r = biz.finance.post("/api/connections/quickbooks/sync")
    assert r.status_code == 200 and r.json()["counts"]["skipped"] == 2
    with tenant_session(biz.id) as db:
        c = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one()
        c.meta = {**c.meta, "cdc_since": None}
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200  # a full read
    assert _records(biz.id)["Invoice:102"].status == "open"  # unreadable is not the same as deleted


def test_sign_in_refreshes_by_itself(fake_qbo, biz):
    fake_qbo.expires_in = 60  # each token is already past our safety margin
    _connect(biz, fake_qbo)
    before = len(fake_qbo.refresh)
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200
    assert len(fake_qbo.refresh) == before  # each refresh replaced the token, and we kept the new one
    assert _connection(biz.id).status == "connected"


def test_signed_out_early_refreshes_once(fake_qbo, biz):
    _connect(biz, fake_qbo)
    fake_qbo.access.clear()  # Intuit dropped our access token
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200


def test_expired_sign_in_asks_to_reconnect_and_stops_polling(fake_qbo, biz):
    _connect(biz, fake_qbo)
    fake_qbo.refresh.clear()
    fake_qbo.access.clear()
    r = biz.finance.post("/api/connections/quickbooks/sync")
    assert r.status_code == 409 and r.json()["detail"] == "The QuickBooks connection has expired. Reconnect."
    c = _connection(biz.id)
    assert c.status == "expired" and c.last_error == "The QuickBooks connection has expired. Reconnect."
    assert biz.id not in scheduler.poll_books(_later(60))
    assert _connect(biz, fake_qbo, _realm(biz.id)) == "connected"
    assert _connection(biz.id).status == "connected" and _connection(biz.id).last_error is None


def test_busy_quickbooks_is_reported_and_retried(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    fake_qbo.fail(f"{realm}/cdc", 429, {"Fault": {"Error": [{"code": "003001", "Message": "ThrottleExceeded"}]}})
    assert biz.id in scheduler.poll_books(_later(11))
    c = _connection(biz.id)
    assert c.status == "error" and c.last_error == "QuickBooks asked us to slow down. We'll try again shortly."
    fake_qbo.fail(f"{realm}/cdc", 503)
    r = biz.finance.post("/api/connections/quickbooks/sync")
    assert r.status_code == 502 and r.json()["detail"] == "QuickBooks didn't respond. Try again in a minute."
    assert biz.finance.post("/api/connections/quickbooks/sync").status_code == 200
    assert _connection(biz.id).status == "connected"


def test_sync_before_connecting(fake_qbo, biz):
    r = biz.finance.post("/api/connections/quickbooks/sync")
    assert r.status_code == 409 and r.json()["detail"] == "Connect the accounting software first."


def test_disconnect_gives_access_back_and_stops_polling(fake_qbo, biz):
    _connect(biz, fake_qbo)
    assert biz.finance.post("/api/connections/quickbooks/disconnect").status_code == 200
    c = _connection(biz.id)
    assert c.status == "disconnected" and c.token_enc is None and "cdc_since" not in c.meta
    assert fake_qbo.revoked
    assert biz.id not in scheduler.poll_books(_later(60))


# ── Notifications ──────────────────────────────────────────────────────────


def _signed(client, payload, secret: str = VERIFIER):
    body = json.dumps(payload).encode()
    sig = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return client.post("/webhooks/quickbooks", content=body, headers={"intuit-signature": sig,
                                                                      "content-type": "application/json"})


def _cloud_event(realm: str, id_: str | None = None) -> list[dict]:
    return [{"specversion": "1.0", "id": id_ or uuid.uuid4().hex, "source": "intuit.dsnBgbseACLLRZNxo2dfc4evmEJdxde58xeeYcZliOU=",
             "type": "qbo.invoice.updated.v1", "datacontenttype": "application/json", "time": datetime.now(UTC).isoformat(),
             "intuitentityid": "102", "intuitaccountid": realm, "data": {}}]


def test_signed_notification_reads_the_change(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    fake_qbo.change(realm, "Invoice", "102", Balance=0)
    event = _cloud_event(realm)
    assert _signed(biz.finance, event).status_code == 200
    assert _records(biz.id)["Invoice:102"].status == "paid"
    cdc = _api_reads(fake_qbo, _realm(biz.id), "cdc")
    assert _signed(biz.finance, event).status_code == 200  # the same notification again
    assert _api_reads(fake_qbo, _realm(biz.id), "cdc") == cdc
    with tenant_session(biz.id) as db:
        assert db.execute(select(AuditEntry).where(AuditEntry.event == "notification_received")).scalars().all()


def test_older_notification_format_still_works(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    fake_qbo.change(realm, "Invoice", "102", Balance=0)
    legacy = {"eventNotifications": [{"realmId": realm, "dataChangeEvent": {"entities": [
        {"name": "Invoice", "id": "102", "operation": "Update", "lastUpdated": datetime.now(UTC).isoformat()}]}}]}
    assert _signed(biz.finance, legacy).status_code == 200
    assert _records(biz.id)["Invoice:102"].status == "paid"


def test_unsigned_or_unknown_notifications_do_nothing(fake_qbo, biz):
    _connect(biz, fake_qbo)
    realm = _realm(biz.id)
    assert _signed(biz.finance, _cloud_event(realm), secret="wrong").status_code == 401
    r = biz.finance.post("/webhooks/quickbooks", content=b"[]")
    assert r.status_code == 401
    cdc = _api_reads(fake_qbo, _realm(biz.id), "cdc")
    assert _signed(biz.finance, _cloud_event("999999")).status_code == 200  # a company nobody connected
    assert _signed(biz.finance, {"something": "else"}).status_code == 200
    assert _api_reads(fake_qbo, _realm(biz.id), "cdc") == cdc


# ── Adding approved bills ──────────────────────────────────────────────────


def _approved_bill(bid, supplier: str = "Oven Doctors Ltd", total: int = 186000, tax: int = 31000) -> uuid.UUID:
    """A bill someone approved from a document, waiting to go into QuickBooks."""
    original = b"%PDF-1.4 oven repair bill " + uuid.uuid4().bytes
    key, digest = archive.put(bid, original)
    with tenant_session(bid) as db:
        cp, _ = find_or_create(db, bid, "supplier", supplier)
        doc = Document(business_id=bid, source="email", status="approved", filename="OD-4471.pdf",
                       mime="application/pdf", size_bytes=len(original), sha256=digest, object_key=key, doc_type="bill")
        db.add(doc)
        db.flush()
        rec = Record(business_id=bid, source="document", source_ref=str(doc.id), kind="bill", direction="out",
                     amount_minor=total, open_minor=total, currency="GBP", date=TODAY - timedelta(days=5),
                     due_date=TODAY + timedelta(days=9), status="open", counterparty_id=cp.id, reference="OD-4471",
                     description="Deck oven repair", tax_minor=tax, document_id=doc.id)
        db.add(rec)
        db.flush()
        doc.record_id = rec.id
        action = actions.propose(db, bid, "post_to_accounting", requested_by="ai:ingestion",
                                 payload={"record_id": str(rec.id), "document_id": str(doc.id)},
                                 summary="Add Oven Doctors Ltd bill to QuickBooks")
        return action.id


def _action(bid, aid) -> Action:
    with tenant_session(bid) as db:
        a = db.get(Action, aid)
        db.expunge(a)
    return a


def test_approved_bill_goes_in_with_the_original(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    r = biz.finance.post(f"/api/actions/{aid}/approve")
    assert r.status_code == 200 and r.json()["status"] == "executed", r.text
    body = fake_qbo.posted[-1]
    assert body["DocNumber"] == "OD-4471" and body["GlobalTaxCalculation"] == "TaxExcluded"
    line = body["Line"][0]
    assert line["Amount"] == 1550.0 and body["TxnTaxDetail"]["TotalTax"] == 310.0
    assert line["AccountBasedExpenseLineDetail"]["TaxCodeRef"] == {"value": "21"}  # standard rate, not reverse charge
    assert line["AccountBasedExpenseLineDetail"]["AccountRef"] == {"value": "62"}  # a new supplier: purchases
    assert len(fake_qbo.uploads) == 1 and b"%PDF-1.4 oven repair bill" in fake_qbo.uploads[0]
    result = _action(biz.id, aid).result
    assert result["total_minor"] == 186000 and result["attachment_id"] == "att1"
    realm = _realm(biz.id)
    vendor = fake_qbo.bills(realm)[result["quickbooks_bill_id"]]["VendorRef"]["value"]
    assert fake_qbo.companies[realm]["rows"]["Vendor"][vendor]["DisplayName"] == "Oven Doctors Ltd"
    # The next read sees the bill in QuickBooks, but it is the same bill: still one record
    scheduler.poll_books(_later(11))
    assert f"Bill:{result['quickbooks_bill_id']}" not in _records(biz.id)


def test_known_supplier_bill_goes_to_its_usual_account(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id, supplier="Acme Supplies Ltd")
    assert biz.finance.post(f"/api/actions/{aid}/approve").json()["status"] == "executed"
    line = fake_qbo.posted[-1]["Line"][0]
    assert line["AccountBasedExpenseLineDetail"]["AccountRef"] == {"value": "60"}  # where bill AS-980 went
    assert fake_qbo.posted[-1]["VendorRef"] == {"value": "31"}  # the supplier QuickBooks already has


def test_quickbooks_busy_while_adding_a_bill_is_safe_to_retry(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    fake_qbo.fail(f"{_realm(biz.id)}/upload", 503)  # the bill is made, then attaching the original fails
    r = biz.finance.post(f"/api/actions/{aid}/approve")
    assert r.status_code == 502 and r.json()["detail"] == "QuickBooks didn't respond. Try again in a minute."
    assert _action(biz.id, aid).status == "pending"  # the approval wasn't used up
    r = biz.finance.post(f"/api/actions/{aid}/approve")
    assert r.status_code == 200 and r.json()["status"] == "executed"
    realm = _realm(biz.id)
    made = [b for b in fake_qbo.bills(realm).values() if b.get("DocNumber") == "OD-4471"]
    assert len(made) == 1 and len(fake_qbo.uploads) == 1


def test_supplier_named_like_a_customer_gets_its_own_name(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id, supplier="Station Coffee Co")
    assert biz.finance.post(f"/api/actions/{aid}/approve").json()["status"] == "executed"
    realm = _realm(biz.id)
    names = {v["DisplayName"] for v in fake_qbo.companies[realm]["rows"]["Vendor"].values()}
    assert "Station Coffee Co (supplier)" in names


def test_bill_for_an_undone_document_is_not_added(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    with tenant_session(biz.id) as db:
        rec = db.get(Record, uuid.UUID(_action(biz.id, aid).payload["record_id"]))
        rec.status = "void"
    r = biz.finance.post(f"/api/actions/{aid}/approve")
    assert r.status_code == 409
    assert fake_qbo.posted == []


def test_staff_cannot_approve_adding_a_bill(fake_qbo, biz):
    _connect(biz, fake_qbo)
    aid = _approved_bill(biz.id)
    staff = biz.sign_in(f"staff@{biz.tag}.test")
    assert staff.post(f"/api/actions/{aid}/approve").status_code == 403
    assert fake_qbo.posted == []
