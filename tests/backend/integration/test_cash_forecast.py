"""Ledger, matching, forecast, warnings, what-if, business health and why cash changed, on the
demo story's books and bank feed. Each figure is checked against an answer worked out from the
story itself (app/demo/story.py), not from our own code."""

import statistics
from datetime import date, timedelta

import pytest
from sqlalchemy import select
from tests.backend import story_books

from app.analytics import forecast, health, ledger
from app.db import tenant_session
from app.demo import story
from app.models import AuditEntry, Match

TODAY = date.today()
PAYOUT = "STRIPE PAYMENTS UK PAYOUT"
BANK_ONLY_COSTS = ("PAYROLL", "RENT", "TESCO", "SCREWFIX", "SHELL", "ROYAL MAIL", "AMAZON")


@pytest.fixture(scope="module")
def books(businesses):
    bid, tag, s, matched = story_books.story_business()
    return {"id": bid, "tag": tag, "story": s, "matched": matched}


def _db(books):
    return tenant_session(books["id"])


def _rate(s: story.Story) -> float:
    net = sum(sum(q * p for _, q, p in inv.lines) for inv in s.invoices)
    return round(sum(inv.total for inv in s.invoices) / net - 1, 4)


# ── Cash and matching ──────────────────────────────────────────────────────


def test_cash_today_is_the_bank_balance(books):
    with _db(books) as db:
        c = ledger.cash(db)
    assert c["balance_minor"] == story.current_balance(books["story"])
    assert c["currency"] == "GBP" and c["left_out"] == []


def test_every_bank_payment_for_a_paid_invoice_or_bill_is_linked_and_nothing_wrong_is_suggested(books):
    s = books["story"]
    paid_numbers = {i.number for i in s.invoices if i.paid_on and not i.short} | {b.number for b in s.bills if b.paid_on}
    by_number = [ln for ln in s.bank if any(n in ln.description for n in paid_numbers)]
    no_number = [ln for ln in s.bank if ln.description in ("BRIGHTSPARK ENERGY DD", "CLOUDDESK SOFTWARE CARD")]
    assert books["matched"]["linked"] == len(by_number) + len(no_number)
    # Payments that arrived short are open in the books, so matching settles them (small and confident)
    short = [i for i in s.invoices if i.short]
    assert books["matched"]["suggested"] == 0 and books["matched"]["auto"] == len(short) > 0
    with _db(books) as db:
        assert db.execute(select(Match).where(Match.status == "suggested")).first() is None


def test_customers_payment_habits(books):
    with _db(books) as db:
        late = forecast.lateness(db, TODAY)
        names = {v: k for k, v in ledger.names(db).items()}
    bright, *_ = late[names["Bright Cafe"]]
    deli, *_ = late[names["Corner Deli"]]
    assert 12 <= bright <= 16  # 12 days late, 16 lately
    assert abs(deli) <= 1


# ── Forecast ───────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def cash_flow(books):
    with _db(books) as db:
        return forecast.build(db, TODAY)


def test_forecast_shape(cash_flow, books):
    series = cash_flow["series"]
    assert len(series) == forecast.HORIZON + 1
    assert series[0]["expected_minor"] == story.current_balance(books["story"])
    assert all(p["worst_minor"] <= p["expected_minor"] <= p["best_minor"] for p in series)
    assert cash_flow["horizons"]["30"] == series[30]["expected_minor"]
    assert cash_flow["lowest"]["balance_minor"] == min(p["expected_minor"] for p in series)


def test_repeating_items_are_found(cash_flow):
    found = {(r["label"], r["every"]): r["amount_minor"] for r in cash_flow["repeating"]}
    assert found[("Payroll", "month")] == -6_850_00
    assert found[("Mill Properties Rent", "month")] == -2_200_00
    assert found[("Northern Asset Finance Van Loan", "month")] == -420_00
    assert ("Card sales payout", "week") in found
    assert ("Acme Supplies Ltd", "week") in found and found[("Acme Supplies Ltd", "week")] < 0
    for c in story.CUSTOMERS:
        assert (c.name, "fortnight" if c.terms == 30 else "week") in found


def test_rent_and_payroll_land_on_their_usual_days(cash_flow):
    items = [i for i in cash_flow["items"] if i["kind"] == "repeating"]
    rent = [date.fromisoformat(i["expected"]) for i in items if i["label"] == "Mill Properties Rent"]
    payroll = [date.fromisoformat(i["expected"]) for i in items if i["label"] == "Payroll"]
    assert rent and all(d.day == 1 for d in rent)
    assert payroll and all(d.day == 28 for d in payroll)


def test_unpaid_invoices_and_bills_are_all_in(cash_flow, books):
    s = books["story"]
    ids = {i["label"].split()[-1] for i in cash_flow["items"] if i["kind"] in ("invoice", "bill")}
    assert ids == {i.number for i in s.invoices if not i.paid_on} | {b.number for b in s.bills if not b.paid_on}
    bills = {i["label"].split()[-1]: i for i in cash_flow["items"] if i["kind"] == "bill"}
    for b in s.bills:
        if not b.paid_on:
            assert bills[b.number]["expected"] == max(b.due, TODAY + timedelta(days=1)).isoformat()
            assert bills[b.number]["amount_minor"] == -b.total


def test_vat_is_estimated_from_the_quarters_invoices_and_bills(cash_flow, books):
    s = books["story"]
    last = max(ln.day for ln in s.bank if ln.description == "HMRC VAT")
    due = last
    while due <= TODAY:
        due = forecast.add_months(due, 3, 7)
    vat = [i for i in cash_flow["items"] if i["kind"] == "tax"]
    if due > TODAY + timedelta(days=forecast.HORIZON):
        assert vat == []
        return
    q_end = forecast.add_months(due.replace(day=1), -1) - timedelta(days=1)
    q_start = forecast.add_months(q_end.replace(day=1), -2)
    out_tax = sum(i.total - sum(q * p for _, q, p in i.lines) for i in s.invoices if q_start <= i.issue <= q_end)
    in_tax = sum(b.total - b.subtotal for b in s.bills if q_start <= b.issue <= q_end)
    card = sum(ln.amount for ln in s.bank if ln.description.startswith(PAYOUT) and q_start <= ln.day <= q_end)
    rate = _rate(s)
    expected = out_tax + round(card * rate / (1 + rate)) - in_tax
    assert [(v["expected"], v["amount_minor"]) for v in vat] == [(due.isoformat(), -expected)]


def test_platform_balance_is_not_counted_twice(books):
    """Card sales sitting in the payment platform arrive with the next payout."""
    with _db(books) as db:
        before = forecast.build(db, TODAY)
        from app.models import Account

        db.add(Account(business_id=books["id"], source="stripe", external_id="bal", name="Stripe balance (GBP)",
                       currency="GBP", balance_minor=500_00))
        db.flush()
        after = forecast.build(db, TODAY)
        db.rollback()
    assert after["balance_minor"] == before["balance_minor"] + 500_00
    assert after["series"][-1]["expected_minor"] == before["series"][-1]["expected_minor"]


def test_another_currency_is_left_out_and_listed(books):
    with _db(books) as db:
        from app.models import Account

        db.add(Account(business_id=books["id"], source="plaid", external_id="eur", name="Euro account",
                       currency="EUR", balance_minor=9_999_00))
        db.flush()
        c = ledger.cash(db)
        f = forecast.build(db, TODAY)
        db.rollback()
    assert c["balance_minor"] == story.current_balance(books["story"])
    assert [a["name"] for a in c["left_out"]] == ["Euro account"]
    assert {"label": "Euro account (EUR)", "count": 1} in f["left_out"]


# ── Warnings and what-if ───────────────────────────────────────────────────


def test_what_if_van(books, cash_flow):
    on = TODAY + timedelta(days=20)
    with _db(books) as db:
        w = forecast.what_if(db, [{"label": "New van", "amount_minor": 20_000_00, "date": on}], [], {}, TODAY)
    before = [p["expected_minor"] for p in cash_flow["series"]]
    after = [p["expected_minor"] for p in w["series"]]
    assert after[:20] == before[:20]
    assert after[20:] == [b - 20_000_00 for b in before[20:]]
    low = min(after)
    assert w["what_if"]["lowest_after"]["balance_minor"] == low
    assert w["what_if"]["lowest_before"] == cash_flow["lowest"]
    assert w["what_if"]["shortfall_minor"] == max(0, w["safety_level_minor"] - low)
    if low < w["safety_level_minor"]:
        first = next(p for p in w["series"] if p["expected_minor"] < w["safety_level_minor"])
        warn = next(x for x in w["warnings"] if x["id"].startswith(("cash-safety", "cash-zero")))
        assert warn["date"] == first["date"]
        if first["date"] == on.isoformat():
            assert warn["sentence"].startswith(f"New van on {on.day} {on:%B} will take you below")


def test_leaving_out_or_moving_a_bill(books, cash_flow):
    bill = next(i for i in cash_flow["items"] if i["kind"] == "bill")
    with _db(books) as db:
        out = forecast.what_if(db, [], [bill["id"]], {}, TODAY)
        later = date.fromisoformat(bill["expected"]) + timedelta(days=10)
        moved = forecast.what_if(db, [], [], {bill["id"]: later}, TODAY)
    i = (date.fromisoformat(bill["expected"]) - TODAY).days
    assert out["series"][i]["expected_minor"] == cash_flow["series"][i]["expected_minor"] - bill["amount_minor"]
    assert moved["series"][i]["expected_minor"] == out["series"][i]["expected_minor"]
    j = min(i + 10, forecast.HORIZON)
    assert moved["series"][j]["expected_minor"] == cash_flow["series"][j]["expected_minor"]


def test_warning_grades():
    start = TODAY
    items = [forecast.Item("bill:x", "Rent", "bill", -900_00, start + timedelta(days=3), start + timedelta(days=3),
                           start + timedelta(days=3))]

    def series(expected, worst):
        return [{"date": (start + timedelta(days=i)).isoformat(), "expected_minor": e, "best_minor": e,
                 "worst_minor": w} for i, (e, w) in enumerate(zip(expected, worst, strict=True))]

    urgent = forecast.warnings(series([1000_00] * 3 + [100_00] * 8, [1000_00] * 3 + [100_00] * 8), items, 500_00)
    assert [(w["grade"], w["severity"]) for w in urgent] == [("urgent", "urgent")]
    assert urgent[0]["sentence"] == "Rent on " + f"{start + timedelta(days=3):%-d %B}" + \
        " will take you below your safety level in 3 days."
    later = forecast.warnings(series([1000_00] * 10 + [100_00], [1000_00] * 10 + [100_00]), [], 500_00)
    assert later[0]["grade"] == "warning"
    watch = forecast.warnings(series([1000_00] * 11, [1000_00] * 10 + [100_00]), [], 500_00)
    assert [w["grade"] for w in watch] == ["watch"]
    zero = forecast.warnings(series([1000_00] * 3 + [-5_00] * 8, [1000_00] * 3 + [-5_00] * 8), items, 500_00)
    assert [w["id"].split("-")[1] for w in zero] == ["zero"]  # below zero says it all
    assert "will take you below zero" in zero[0]["sentence"]


def test_safety_level_defaults_to_two_weeks_of_spending(books, cash_flow):
    s = books["story"]
    start = TODAY - timedelta(days=90)
    spent = sum(-ln.amount for ln in s.bank if ln.amount < 0 and start <= ln.day <= TODAY)
    assert cash_flow["safety_level_minor"] == round(spent / 90 * 14 / 10_000) * 10_000


# ── Business health ────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def healthy(books):
    with _db(books) as db:
        return health.summary(db, TODAY)


def test_profit_and_loss_by_month(books, healthy):
    s = books["story"]
    rate = _rate(s)
    paid_bill_refs = {b.number for b in s.bills if b.paid_on}
    for m in healthy["profit_and_loss"]:
        y, mo = map(int, m["month"].split("-"))

        def inside(d, y=y, mo=mo):
            return (d.year, d.month) == (y, mo) and d <= TODAY

        sales = sum(sum(q * p for _, q, p in i.lines) for i in s.invoices if inside(i.issue)) + sum(
            round(ln.amount / (1 + rate)) for ln in s.bank if ln.description.startswith(PAYOUT) and inside(ln.day))
        costs = sum(b.subtotal for b in s.bills if inside(b.issue)) + sum(
            -ln.amount for ln in s.bank if ln.amount < 0 and inside(ln.day)
            and any(w in ln.description for w in BANK_ONLY_COSTS)
            and not any(r in ln.description for r in paid_bill_refs))
        assert (m["sales_minor"], m["costs_minor"]) == (sales, costs), m["month"]
        assert m["profit_minor"] == sales - costs


def test_who_owes_you_and_days_to_get_paid(books, healthy):
    s = books["story"]
    unpaid = [i for i in s.invoices if not i.paid_on]
    assert healthy["owed"]["total_minor"] == sum(i.total for i in unpaid)
    assert sum(b["amount_minor"] for b in healthy["who_owes_you"]) == sum(i.total for i in unpaid)
    recent = [i for i in s.invoices if i.paid_on and i.paid_on >= TODAY - timedelta(days=90)]
    weighted = sum((i.paid_on - i.issue).days * i.total for i in recent) / sum(i.total for i in recent)
    assert healthy["days_to_get_paid"] == round(weighted, 1)


def test_spending_and_top_suppliers(healthy):
    cats = {c["category"]: c["amount_minor"] for c in healthy["spending"]}
    assert cats["Salaries"] == max(cats.values())
    assert "Cost of sales" in cats and "Rent" in cats
    assert healthy["top_suppliers"][0]["name"] == "Payroll"
    assert "Acme Supplies Ltd" in [t["name"] for t in healthy["top_suppliers"][:3]]


def test_runway_only_when_spending_more_than_earning(books, healthy):
    s = books["story"]
    start = TODAY - timedelta(days=90)
    net = sum(ln.amount for ln in s.bank if start <= ln.day <= TODAY)
    assert healthy["monthly_net_minor"] == round(net / 3)
    assert (healthy["runway_months"] is None) == (net >= 0)


def test_health_checks():
    def month(label, sales, costs, complete=True):
        return {"label": label, "sales_minor": sales, "costs_minor": costs, "profit_minor": sales - costs,
                "complete": complete}

    growing_costs = [month("Jan", 100, 50), month("Feb", 110, 60), month("Mar", 115, 70), month("Apr", 118, 80)]
    out = health.checks(growing_costs, {"over_30_share": 0.25}, 2.5)
    assert {c["id"] for c in out} == {"costs-outgrowing-sales", "overdue-invoices", "short-runway"}
    falling = [month(m, 100, 60) for m in "ABC"] + [month(m, 100, 70) for m in "DEF"]
    assert "margin-falling" in {c["id"] for c in health.checks(falling, {"over_30_share": 0}, None)}
    assert health.checks([month("A", 100, 50)] * 6, {"over_30_share": 0.2}, 3.0) == []


# ── Why cash changed ───────────────────────────────────────────────────────


@pytest.mark.parametrize("period", ["month", "30d"])
def test_why_cash_changed_adds_up(books, period):
    s = books["story"]
    with _db(books) as db:
        w = health.why_cash_changed(db, TODAY, period)
    for key in ("this_period", "last_period"):
        lo, hi = date.fromisoformat(w[key]["from"]), date.fromisoformat(w[key]["to"])
        assert w[key]["net_minor"] == sum(ln.amount for ln in s.bank if lo <= ln.day <= hi)
    assert w["change_minor"] == w["this_period"]["net_minor"] - w["last_period"]["net_minor"]
    assert sum(r["change_minor"] for r in w["reasons"]) == w["change_minor"]
    assert [abs(r["change_minor"]) for r in w["reasons"]] == sorted((abs(r["change_minor"]) for r in w["reasons"]),
                                                                     reverse=True)
    if w["reasons"]:
        assert f"£{abs(w['change_minor']) / 100:,.2f}" in w["sentence"]


# ── API ────────────────────────────────────────────────────────────────────


def test_screens_need_the_right_role(books, sign_in):
    staff = sign_in(f"staff@{books['tag']}.test")
    books_person = sign_in(f"books@{books['tag']}.test")
    for path in ("/api/cash", "/api/cash-flow", "/api/business-health", "/api/home", "/api/cash-flow/why",
                 "/api/matches"):
        assert staff.get(path).status_code == 403, path
        assert books_person.get(path).status_code == 200, path


def test_home_summary(books, sign_in):
    owner = sign_in(f"owner@{books['tag']}.test")
    h = owner.get("/api/home").json()
    s = books["story"]
    assert h["cash"]["balance_minor"] == story.current_balance(s)
    assert len(h["cash"]["forecast"]) == 31
    soon = [b for b in s.bills if not b.paid_on and b.due <= TODAY + timedelta(days=7)]
    assert h["bills_due"] == {"count": len(soon), "total_minor": sum(b.total for b in soon),
                              "next_due_date": min(b.due for b in s.bills if not b.paid_on).isoformat()}
    assert h["who_owes_you"]["total_minor"] == sum(i.total for i in s.invoices if not i.paid_on)


def test_what_if_over_the_api(books, sign_in):
    finance = sign_in(f"finance@{books['tag']}.test")
    on = (TODAY + timedelta(days=30)).isoformat()
    r = finance.post("/api/cash-flow/what-if", json={"planned": [{"label": "New van", "amount_minor": 20_000_00,
                                                                  "date": on}]})
    assert r.status_code == 200, r.text
    assert r.json()["what_if"]["lowest_after"]["balance_minor"] <= r.json()["what_if"]["lowest_before"]["balance_minor"]
    for bad in ({"label": "Van", "amount_minor": -5, "date": on}, {"label": "", "amount_minor": 5, "date": on},
                {"label": "Van", "amount_minor": 5, "date": "2099-01-01"}):
        assert finance.post("/api/cash-flow/what-if", json={"planned": [bad]}).status_code == 422, bad


def test_planned_costs_are_kept_and_audited(books, sign_in):
    finance = sign_in(f"finance@{books['tag']}.test")
    bookkeeper = sign_in(f"books@{books['tag']}.test")
    on = (TODAY + timedelta(days=12)).isoformat()
    body = {"label": "Oven deposit", "amount_minor": 1_500_00, "date": on}
    assert bookkeeper.post("/api/planned-items", json=body).status_code == 403
    before = finance.get("/api/cash-flow").json()
    r = finance.post("/api/planned-items", json=body)
    assert r.status_code == 200, r.text
    after = finance.get("/api/cash-flow").json()
    assert any(i["label"] == "Oven deposit" and i["expected"] == on for i in after["items"])
    assert after["series"][-1]["expected_minor"] == before["series"][-1]["expected_minor"] - 1_500_00
    assert finance.delete(f"/api/planned-items/{r.json()['id']}").status_code == 200
    assert finance.get("/api/cash-flow").json()["series"][-1] == before["series"][-1]
    with _db(books) as db:
        events = [e.event for e in db.execute(select(AuditEntry).where(AuditEntry.subject == f"planned:{r.json()['id']}"))
                  .scalars()]
    assert events == ["planned_item_added", "planned_item_removed"]


def test_safety_level_is_the_owners_to_set(books, sign_in):
    owner = sign_in(f"owner@{books['tag']}.test")
    finance = sign_in(f"finance@{books['tag']}.test")
    assert finance.put("/api/settings/safety-level", json={"amount_minor": 1}).status_code == 403
    assert owner.put("/api/settings/safety-level", json={"amount_minor": 12_000_00}).json() == \
        {"safety_level_minor": 12_000_00}
    f = owner.get("/api/cash-flow").json()
    assert (f["safety_level_minor"], f["safety_level_why"]) == (12_000_00, "Set by you")
    owner.put("/api/settings/safety-level", json={"amount_minor": None})
    assert owner.get("/api/cash-flow").json()["safety_level_why"].startswith("Two weeks")


def test_an_empty_business_has_an_empty_forecast(businesses, sign_in):
    bid, tag = story_books.new_business()
    owner = sign_in(f"owner@{tag}.test")
    f = owner.get("/api/cash-flow").json()
    assert f["balance_minor"] == 0 and f["items"] == [] and f["warnings"] == []
    h = owner.get("/api/business-health").json()
    assert h["profit_minor"] == 0 and h["checks"] == []
    assert owner.get("/api/cash-flow/why").json()["reasons"] == []


def test_story_lateness_is_what_the_story_says():
    """Guards the test data: the story's slow payer is still slow."""
    s = story.build()
    late = [(i.paid_on - i.due).days for i in s.invoices if i.customer == "Bright Cafe" and i.paid_on]
    assert statistics.fmean(late) >= 10
