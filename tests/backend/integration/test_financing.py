"""Financing on the demo story: the need from the forecast, eligibility with near misses, cost,
the effect on the forecast, the profile with corrections, and the lender pack, whose sharing
needs a business owner's approval."""

import math
from datetime import date

import fitz
import pytest
from sqlalchemy import select
from tests.backend import story_books

from app.analytics import financing, forecast
from app.db import tenant_session
from app.models import Action, AuditEntry, Business

TODAY = date.today()


@pytest.fixture(scope="module")
def books(businesses):
    bid, tag, s, _ = story_books.story_business()
    with tenant_session(bid) as db:
        low = forecast.build(db, TODAY)["lowest"]["balance_minor"]
        db.get(Business, bid).safety_level_minor = low + 3_000_00  # the owner wants a bigger cushion
    return {"id": bid, "tag": tag, "story": s, "safety": low + 3_000_00}


def _options(bid, **kw):
    with tenant_session(bid) as db:
        return financing.options(db, TODAY, **kw)


def test_the_need_comes_from_the_forecast(books):
    with tenant_session(books["id"]) as db:
        fc = forecast.build(db, TODAY)
    g = _options(books["id"])["gap"]
    first = next(p for p in fc["series"][1:] if p["expected_minor"] < books["safety"])
    assert g["starts_on"] == first["date"]
    missing = books["safety"] - fc["lowest"]["balance_minor"]
    assert g["amount_minor"] == math.ceil(missing * 1.05 / 100_00) * 100_00  # plus 5% for the cost, to £100
    assert g["lowest_on"] == fc["lowest"]["date"]


def test_options_are_ranked_free_first_then_those_that_close_the_gap_by_cost(books):
    o = [x for x in _options(books["id"])["options"] if x["eligible"] and x.get("quote")]
    assert o[0]["free"]
    paid = [x for x in o if not x["free"]]
    closing = [x for x in paid if x["quote"]["closes_gap"]]
    assert closing and paid[:len(closing)] == closing  # those that keep cash above the level come first
    costs = [x["quote"]["total_cost_minor"] for x in closing]
    assert costs == sorted(costs)
    for x in closing:
        assert "stays above your safety level" in x["quote"]["forecast_effect"]


def test_near_misses_say_what_would_change(books):
    found = _options(books["id"])
    o = {x["id"]: x for x in found["options"]}
    months = found["profile"]["values"]["months_trading"]
    assert months == 6 and not o["bank-loan"]["eligible"]  # the story starts six months ago
    assert o["bank-loan"]["eligibility_note"] == f"Available after {24 - months} more months of trading."
    assert o["startup-loan"]["eligible"]  # trading under 3 years
    assert not o["asset-finance"]["eligible"]


def test_an_amount_the_owner_types_in(books):
    o = _options(books["id"], amount=20_000_00, months=24, purpose="vehicle")
    assert o["need"] == {"amount_minor": 20_000_00, "months": 24, "source": "you"}
    fast = next(x for x in o["options"] if x["id"] == "fast-loan")
    assert fast["quote"]["amount_minor"] == 20_000_00 and fast["quote"]["months"] == 24


def test_quote_over_the_api(books, sign_in):
    c = sign_in(f"finance@{books['tag']}.test")
    r = c.post("/api/financing/quote", json={"option_id": "fast-loan", "amount_minor": 10_000_00, "months": 12})
    assert r.status_code == 200, r.text
    q = r.json()
    p = financing.product("fast-loan")
    i = (p["rate_min"] + p["rate_max"]) / 2 / 12
    monthly = 10_000_00 * i / (1 - (1 + i) ** -12)
    assert q["monthly_repayment_minor"] == round(monthly)
    assert q["total_cost_minor"] == round(monthly * 12 - 10_000_00) + round(10_000_00 * p["fee_pct"])
    assert len(q["series"]) == 91 and q["forecast_effect"].startswith("With this")
    bad = c.post("/api/financing/quote", json={"option_id": "fast-loan", "amount_minor": 1_00, "months": 12})
    assert bad.status_code == 422 and "Choose between" in bad.json()["detail"]
    assert c.post("/api/financing/quote", json={"option_id": "nope", "amount_minor": 10_000_00,
                                               "months": 12}).status_code == 404


def test_financing_is_for_finance_managers_and_owners(books, sign_in):
    assert sign_in(f"books@{books['tag']}.test").get("/api/financing").status_code == 403
    r = sign_in(f"finance@{books['tag']}.test").get("/api/financing")
    assert r.status_code == 200 and r.json()["gap"] and "not financial advice" in r.json()["disclaimer"]
    assert r.json()["summary"]["text"]


def test_profile_corrections_keep_the_automatic_value(books, sign_in):
    finance = sign_in(f"finance@{books['tag']}.test")
    owner = sign_in(f"owner@{books['tag']}.test")
    auto = {f["field"]: f["auto"] for f in finance.get("/api/business-profile").json()["fields"]}
    assert finance.put("/api/business-profile", json={"overrides": {"months_trading": 30}}).status_code == 403
    r = owner.put("/api/business-profile", json={"owner_fields": {"industry": "Bakery", "business_type": "Sole trader"},
                                                 "overrides": {"months_trading": 30}})
    assert r.status_code == 200, r.text
    fields = {f["field"]: f for f in r.json()["fields"]}
    assert fields["months_trading"]["value"] == 30 and fields["months_trading"]["auto"] == auto["months_trading"]
    assert fields["months_trading"]["corrected"] and fields["months_trading"]["corrected_by"]
    assert r.json()["owner_fields"]["business_type"] == "sole_trader"
    o = {x["id"]: x for x in _options(books["id"])["options"]}
    assert o["bank-loan"]["eligible"]  # matching uses the corrected value
    assert not o["growth-loan"]["eligible"] and "type of business" in " ".join(o["growth-loan"]["reasons"])
    assert owner.put("/api/business-profile", json={"owner_fields": {"credit_band": "superb"}}).status_code == 422
    owner.put("/api/business-profile", json={"overrides": {"months_trading": None}})  # back to automatic
    with tenant_session(books["id"]) as db:
        assert db.execute(select(AuditEntry).where(AuditEntry.event == "profile_updated")).first()


def test_lender_pack_pdf(books, sign_in):
    c = sign_in(f"finance@{books['tag']}.test")
    r = c.get("/api/lender-pack.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    text = "".join(page.get_text() for page in fitz.open(stream=r.content, filetype="pdf"))
    assert "Lender pack" in text and "Profit and loss" in text and "Unpaid invoices" in text
    unpaid = [i for i in books["story"].invoices if not i.paid_on]
    assert all(i.number in text for i in unpaid[:5])
    assert sign_in(f"books@{books['tag']}.test").get("/api/lender-pack.pdf").status_code == 403


def test_sharing_the_lender_pack_needs_an_owner(books, sign_in, monkeypatch):
    from app.connectors import email_out

    sent = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append((to, kw)) or "<id@x>")
    finance = sign_in(f"finance@{books['tag']}.test")
    owner = sign_in(f"owner@{books['tag']}.test")
    assert sign_in(f"books@{books['tag']}.test").post(
        "/api/lender-pack/share", json={"lender_name": "Bank", "email": "loans@lender.example"}).status_code == 403
    assert finance.post("/api/lender-pack/share", json={"lender_name": "Bank", "email": "not-an-email"}).status_code == 422
    a = finance.post("/api/lender-pack/share", json={"lender_name": "Northgate", "email": "loans@lender.example"}).json()["action"]
    assert a["type"] == "share_lender_pack" and a["level"] == 3 and a["status"] == "pending"
    assert finance.post(f"/api/actions/{a['id']}/approve").status_code == 403  # only a business owner
    assert sent == []
    assert owner.post(f"/api/actions/{a['id']}/approve").json()["status"] == "executed"
    to, kw = sent[0]
    _, mime, pdf = kw["attachments"][0]
    assert to == "loans@lender.example" and mime == "application/pdf" and pdf.startswith(b"%PDF")
    with tenant_session(books["id"]) as db:
        stored = db.get(Action, a["id"]).payload
    from app.security.crypto import sha256_hex

    assert sha256_hex(pdf) == stored["sha256"]  # exactly what was prepared and approved
