"""Financing options (docs/ALGORITHMS.md, section 10): the business profile, the catalog, matching,
cost, the effect on the forecast and the readiness checklist.

Every figure is calculated from our records. The catalog is sample data in the demo. We present
the options as information, never as personal financial advice, and never apply for anything.
"""

import json
import math
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import BusinessProfile, Connection, Record
from . import forecast, health, ledger

CATALOG = Path(__file__).resolve().parents[1] / "data" / "financing_catalog.json"
NEED_MARGIN = 0.05
CREDIT_BANDS = ["poor", "fair", "good", "excellent"]
BUSINESS_TYPES = ["sole_trader", "partnership", "limited_company"]
PURPOSES = ["cash_flow", "stock", "vehicle", "equipment", "premises", "growth", "tax_bill", "other"]
OWNER_FIELDS = {"industry": str, "business_type": BUSINESS_TYPES, "assets": str, "credit_band": CREDIT_BANDS,
                "purpose": PURPOSES, "country": str}
AUTO_LABELS = {
    "months_trading": "Months trading",
    "monthly_sales_minor": "Average monthly sales (6 months, before VAT)",
    "sales_trend_pct": "Sales trend (last 3 months against the 3 before)",
    "card_share": "Share of sales paid by card",
    "card_sales_monthly_minor": "Card sales a month",
    "unpaid_invoices_minor": "Unpaid invoices",
    "overdue_share": "Share of unpaid invoices over 30 days overdue",
    "days_to_get_paid": "Days to get paid",
    "repayments_monthly_minor": "Existing loan repayments a month",
    "cash_in_monthly_minor": "Money coming in a month",
}
DISCLAIMER = ("These options are information to help you compare, not financial advice. Rates and rules are "
              "samples; a lender decides on its own terms. We never apply for anything on your behalf.")


def choice(value, allowed: list[str]):
    """'Limited company' and 'limited_company' are the same choice."""
    if value in (None, ""):
        return None
    v = str(value).strip().lower().replace(" ", "_").replace("-", "_")
    return v if v in allowed else None


@lru_cache(maxsize=1)
def catalog() -> list[dict]:
    return json.loads(CATALOG.read_text())["products"]


def product(product_id: str) -> dict | None:
    return next((p for p in catalog() if p["id"] == product_id), None)


def _money(minor: float) -> str:
    return f"£{abs(minor) / 100:,.2f}"


def _round_up(minor: int, step: int = 100_00) -> int:
    return int(math.ceil(max(minor, 0) / step) * step)


# ── Business profile ───────────────────────────────────────────────────────


def auto_profile(db: Session, today: date) -> dict:
    """What we can tell from the records alone."""
    biz = ledger.business(db)
    first = db.execute(select(func.min(Record.date)).where(Record.status != "void")).scalar()
    months = max(0, (today.year - first.year) * 12 + today.month - first.month) if first else 0
    pnl = [m for m in health.profit_and_loss(db, today) if m["complete"]]
    last6 = pnl[-6:]
    sales6 = [m["sales_minor"] for m in last6]
    monthly_sales = round(sum(sales6) / len(sales6)) if sales6 else 0
    trend = None
    if len(last6) >= 6 and sum(sales6[:3]):
        trend = round((sum(sales6[3:]) / sum(sales6[:3]) - 1) * 100, 1)
    entries = health.entries(db, forecast.add_months(today.replace(day=1), -6), today.replace(day=1) - timedelta(days=1))
    card = sum(e.amount for e in entries if e.side == "sales" and e.category == "card sales")
    sales = sum(e.amount for e in entries if e.side == "sales")
    owed = health.who_owes_you(db, today)
    lines = ledger.bank_lines(db, since=today - timedelta(days=90), until=today)
    repay = sum(ln.record.amount_minor for ln in lines if ln.group == "financing" and ln.record.direction == "out")
    cash_in = sum(ln.record.amount_minor for ln in lines if ln.record.direction == "in")
    return {
        "months_trading": months,
        "monthly_sales_minor": monthly_sales,
        "sales_trend_pct": trend,
        "card_share": round(card / sales, 3) if sales else 0.0,
        "card_sales_monthly_minor": round(card / 6),
        "unpaid_invoices_minor": owed["total_minor"],
        "overdue_share": owed["over_30_share"],
        "days_to_get_paid": health.days_to_get_paid(db, today),
        "repayments_monthly_minor": round(repay / 3),
        "cash_in_monthly_minor": round(cash_in / 3),
        "country": biz.country,
    }


def profile(db: Session, today: date | None = None) -> dict:
    """The profile used for matching: automatic values, the owner's corrections next to them,
    and the details only the owner can add."""
    today = today or date.today()
    biz = ledger.business(db)
    row = db.get(BusinessProfile, biz.id)
    auto = auto_profile(db, today)
    overrides = (row.overrides if row else {}) or {}
    owner = (row.owner_fields if row else {}) or {}
    values = {k: (overrides[k]["value"] if k in overrides else v) for k, v in auto.items()}
    values |= {k: v for k, v in owner.items() if v not in (None, "")}
    for k, allowed in OWNER_FIELDS.items():
        if isinstance(allowed, list) and k in values:
            values[k] = choice(values[k], allowed)
    fields = [{"field": k, "label": AUTO_LABELS.get(k, k.replace("_", " ").capitalize()), "auto": v,
               "value": values.get(k), "corrected": k in overrides,
               "corrected_by": overrides.get(k, {}).get("by"), "corrected_at": overrides.get(k, {}).get("at")}
              for k, v in auto.items() if k != "country"]
    return {"values": values, "fields": fields,
            "owner_fields": {k: owner.get(k, biz.country if k == "country" else None) for k in OWNER_FIELDS},
            "choices": {"business_type": BUSINESS_TYPES, "credit_band": CREDIT_BANDS, "purpose": PURPOSES}}


def save_profile(db: Session, business_id, user_id, owner_fields: dict, overrides: dict) -> BusinessProfile:
    row = db.get(BusinessProfile, business_id)
    if not row:
        row = BusinessProfile(business_id=business_id, owner_fields={}, overrides={})
        db.add(row)
    owner = dict(row.owner_fields or {})
    for k, v in owner_fields.items():
        if k not in OWNER_FIELDS:
            raise ValueError(f"unknown field {k}")
        allowed = OWNER_FIELDS[k]
        if isinstance(allowed, list) and v not in (None, ""):
            if not choice(v, allowed):
                raise ValueError(f"{k} must be one of {', '.join(allowed)}")
            v = choice(v, allowed)
        owner[k] = v.strip()[:120] if isinstance(v, str) else v
    auto = auto_profile(db, date.today())
    corr = dict(row.overrides or {})
    for k, v in overrides.items():
        if k not in AUTO_LABELS:
            raise ValueError(f"unknown field {k}")
        if v is None:
            corr.pop(k, None)  # back to the automatic value
        else:
            corr[k] = {"auto": auto.get(k), "value": v, "by": str(user_id), "at": datetime.now(UTC).isoformat()}
    row.owner_fields, row.overrides = owner, corr
    return row


# ── The need ───────────────────────────────────────────────────────────────


def gap(fc: dict) -> dict | None:
    """From the forecast: the safety level minus the lowest expected balance (plus 5%, rounded up to
    £100), and how long cash stays below it."""
    series, safety = fc["series"], fc["safety_level_minor"]
    below = [i for i, p in enumerate(series) if i and p["expected_minor"] < safety]
    if not below:
        return None
    start = below[0]
    low_i = min(range(len(series)), key=lambda i: series[i]["expected_minor"])
    end = next((i for i in range(low_i, len(series)) if series[i]["expected_minor"] >= safety), len(series) - 1)
    # plus a margin for what borrowing costs, so repayments don't take cash straight back below the level
    amount = _round_up((safety - series[low_i]["expected_minor"]) * (1 + NEED_MARGIN))
    return {"amount_minor": amount, "starts_on": series[start]["date"], "lowest_on": series[low_i]["date"],
            "ends_on": series[end]["date"], "days": max(end - start, 1),
            # long enough that repayments start after cash is back above the safety level
            "months": max(1, math.ceil((end - start + 2) / 30)), "safety_level_minor": safety,
            "lowest_minor": series[low_i]["expected_minor"], "recovers": series[end]["expected_minor"] >= safety}


# ── Eligibility ────────────────────────────────────────────────────────────


def eligibility(p: dict, values: dict, open_bills_minor: int) -> tuple[bool, list[str]]:
    """(eligible, reasons it is not, as near misses where possible)."""
    rules, why = p.get("rules") or {}, []
    months = values.get("months_trading") or 0
    if rules.get("min_months_trading") and months < rules["min_months_trading"]:
        why.append(f"Available after {rules['min_months_trading'] - months} more months of trading.")
    if rules.get("max_months_trading") and months > rules["max_months_trading"]:
        why.append(f"Only for businesses trading under {rules['max_months_trading']} months.")
    if rules.get("min_monthly_sales_minor") and (values.get("monthly_sales_minor") or 0) < rules["min_monthly_sales_minor"]:
        why.append(f"Needs monthly sales of {_money(rules['min_monthly_sales_minor'])} or more.")
    if rules.get("countries") and (values.get("country") or "GB") not in rules["countries"]:
        why.append("Not offered in your country.")
    if rules.get("business_types") and values.get("business_type") and values["business_type"] not in rules["business_types"]:
        why.append("Not offered to your type of business.")
    if rules.get("purposes") and values.get("purpose") not in rules["purposes"]:
        why.append("Only for buying " + " or ".join(rules["purposes"]) + ".")
    band = values.get("credit_band")
    if rules.get("min_credit_band") and band and CREDIT_BANDS.index(band) < CREDIT_BANDS.index(rules["min_credit_band"]):
        why.append(f"Usually needs a {rules['min_credit_band']} or better credit history.")
    if rules.get("min_card_share") and (values.get("card_share") or 0) < rules["min_card_share"]:
        why.append(f"Needs at least {rules['min_card_share'] * 100:.0f}% of sales paid by card.")
    if rules.get("min_card_sales_monthly_minor") and (values.get("card_sales_monthly_minor") or 0) < rules["min_card_sales_monthly_minor"]:
        why.append(f"Needs card sales of {_money(rules['min_card_sales_monthly_minor'])} a month or more.")
    if rules.get("min_unpaid_invoices_minor") and (values.get("unpaid_invoices_minor") or 0) < rules["min_unpaid_invoices_minor"]:
        why.append(f"Needs unpaid invoices of {_money(rules['min_unpaid_invoices_minor'])} or more.")
    if rules.get("needs_open_bills") and open_bills_minor <= 0:
        why.append("You have no unpaid bills to ask about.")
    return not why, why


def limit(p: dict, values: dict, open_bills_minor: int) -> int:
    """The most this option can give this business."""
    top = p["max_minor"]
    if p["type"] == "invoice_finance":
        top = min(top, int((values.get("unpaid_invoices_minor") or 0) * p.get("advance", 0.85)))
    elif p["type"] == "early_payment":
        top = min(top, values.get("unpaid_invoices_minor") or 0)
    elif p["type"] == "supplier_terms":
        top = min(top, open_bills_minor)
    elif p["type"] == "merchant_cash_advance":
        top = min(top, (values.get("card_sales_monthly_minor") or 0) * 2)
    return max(top, 0)


# ── Cost and repayments ────────────────────────────────────────────────────


def _monthly_payment(amount: int, annual: float, months: int) -> float:
    i = annual / 12
    return amount / months if i == 0 else amount * i / (1 - (1 + i) ** -months)


def quote(p: dict, amount: int, months: int, values: dict, start: date) -> dict:
    """Cost at the middle of the rate range (and at both ends), the monthly repayment, and the money
    in and out it adds to the forecast."""
    mid = (p["rate_min"] + p["rate_max"]) / 2
    kind = p["type"]
    fee = round(amount * p.get("fee_pct", 0)) + p.get("fee_minor", 0)
    flows: list[tuple[date, int]] = []
    yearly_pct = None

    def cost_at(rate: float) -> int:
        if kind == "term_loan":
            return round(_monthly_payment(amount, rate, months) * months - amount) + fee
        if kind == "credit_line":
            return round(amount * rate * months * 30 / 365) + fee
        if kind == "invoice_finance":
            invoices = amount / p.get("advance", 0.85)
            out_months = max(1.0, (values.get("days_to_get_paid") or 30) / 30)
            return round(invoices * rate * out_months) + fee
        if kind == "merchant_cash_advance":
            return round(amount * (rate - 1))
        if kind == "early_payment":
            return round(amount * rate)
        return 0

    total = cost_at(mid)
    low, high = cost_at(p["rate_min"]), cost_at(p["rate_max"])
    if kind == "term_loan":
        pay = _monthly_payment(amount, mid, months)
        monthly = round(pay)
        flows.append((start, amount - fee))
        flows += [(forecast.add_months(start, k), -monthly) for k in range(1, months + 1)]
    elif kind == "credit_line":
        interest = round(amount * mid * 30 / 365)
        monthly = interest
        flows.append((start, amount - fee))
        flows += [(forecast.add_months(start, k), -interest) for k in range(1, months + 1)]
        flows.append((forecast.add_months(start, months), -amount))
    elif kind == "invoice_finance":
        collect = start + timedelta(days=round(values.get("days_to_get_paid") or 30))
        monthly = round(total / max(1.0, (values.get("days_to_get_paid") or 30) / 30))
        flows += [(start, amount), (collect, -(amount + total))]
    elif kind == "merchant_cash_advance":
        share = p.get("share_of_card_sales", 0.12)
        weekly = max(1, round((values.get("card_sales_monthly_minor") or 0) * 12 / 52 * share))
        owed, d = amount + total, start
        flows.append((start, amount))
        while owed > 0:
            d += timedelta(days=7)
            step = min(weekly, owed)
            flows.append((d, -step))
            owed -= step
        weeks = max(1, (d - start).days / 7)
        months = max(1, round(weeks / 4.33))
        monthly = round(weekly * 52 / 12)
        yearly_pct = round(total / amount / (weeks / 52) * 100, 1)
    elif kind == "early_payment":
        monthly = 0
        flows += [(start, amount - total), (start + timedelta(days=30), -amount)]
    else:  # supplier terms: pay the bills later
        monthly = 0
        flows += [(start, amount), (forecast.add_months(start, months), -amount)]
    if kind in ("term_loan", "credit_line") and amount:
        yearly_pct = round(mid * 100, 1)
    return {"amount_minor": amount, "months": months, "total_cost_minor": total,
            "cost_range_minor": [low, high], "monthly_repayment_minor": monthly, "fee_minor": fee,
            "rate_pct": [round(p["rate_min"] * 100, 1), round(p["rate_max"] * 100, 1)]
            if kind not in ("merchant_cash_advance",) else None,
            "factor": [p["rate_min"], p["rate_max"]] if kind == "merchant_cash_advance" else None,
            "yearly_cost_pct": yearly_pct, "flows": flows}


def effect(fc: dict, flows: list[tuple[date, int]]) -> dict:
    """The forecast with this option's money in and repayments added. The forecast is a running
    total, so each flow simply moves every day after it."""
    safety = fc["safety_level_minor"]
    series = fc["series"]
    end = date.fromisoformat(series[-1]["date"])
    added, running, by_day = [], 0, {}
    for d, amount in flows:
        if d <= end:
            by_day[d] = by_day.get(d, 0) + amount
    for p in series:
        running += by_day.get(date.fromisoformat(p["date"]), 0)
        added.append(p["expected_minor"] + running)
    low_i = min(range(len(added)), key=lambda i: added[i])
    below = next((i for i in range(1, len(added)) if added[i] < safety), None)
    if below is None:
        sentence = f"With this, cash stays above your safety level for the next {len(series) - 1} days."
    else:
        d = date.fromisoformat(series[below]["date"])
        sentence = f"With this, cash still drops below your safety level on {d.day} {d:%B} ({_money(added[below])})."
    return {"closes_gap": below is None, "lowest_minor": added[low_i], "lowest_on": series[low_i]["date"],
            "first_below_on": series[below]["date"] if below is not None else None, "forecast_effect": sentence,
            "series": [{"date": p["date"], "expected_minor": v} for p, v in zip(series, added, strict=True)]}


# ── Matching and ranking ───────────────────────────────────────────────────


def _open_bills(db: Session) -> int:
    bills, _ = ledger.open_items(db, "bill")
    return sum(b.open_minor for b in bills)


def options(db: Session, today: date | None = None, amount: int | None = None, months: int | None = None,
            purpose: str | None = None) -> dict:
    """Every option, checked against the profile, costed for the need, run through the forecast and ranked."""
    today = today or date.today()
    fc = forecast.build(db, today)
    prof = profile(db, today)
    values = dict(prof["values"])
    if purpose:
        values["purpose"] = purpose
    g = gap(fc)
    need_amount = amount or (g["amount_minor"] if g else None)
    need_months = months or (g["months"] if g else None)
    start = date.fromisoformat(g["starts_on"]) - timedelta(days=1) if g and not amount else today + timedelta(days=1)
    start = max(start, today + timedelta(days=1))
    bills = _open_bills(db)
    out = []
    for p in catalog():
        ok, why = eligibility(p, values, bills)
        top = limit(p, values, bills)
        item = {k: p[k] for k in ("id", "type", "provider", "product", "free", "min_minor", "max_minor",
                                  "min_months", "max_months", "about")}
        item |= {"limit_minor": top, "eligible": ok, "reasons": why, "eligibility_note": why[0] if why else None}
        if need_amount:
            amt = min(max(need_amount, p["min_minor"]), top) if top >= p["min_minor"] else 0
            mon = min(max(need_months or p["min_months"], p["min_months"]), p["max_months"])
            if amt:
                q = quote(p, amt, mon, values, start)
                eff = effect(fc, q.pop("flows"))
                eff.pop("series")
                item["quote"] = {**q, **eff, "covers_need": amt >= need_amount}
            elif ok:
                item["reasons"] = why = [f"The most this could give you is {_money(top)}."]
                item["eligibility_note"] = why[0]
        out.append(item)

    def rank(o):
        q = o.get("quote") or {}
        return (not o["eligible"], not o["free"], not q.get("closes_gap", False), q.get("total_cost_minor", 1e15))

    out.sort(key=rank)
    return {"gap": g, "need": {"amount_minor": need_amount, "months": need_months,
                               "source": "you" if amount else "forecast" if g else None},
            "options": out, "readiness": readiness(db, values), "profile": prof,
            "safety_level_minor": fc["safety_level_minor"], "disclaimer": DISCLAIMER}


def quote_one(db: Session, product_id: str, amount: int, months: int, today: date | None = None) -> dict:
    """The sliders on the Financing page: one option at a chosen amount and term."""
    today = today or date.today()
    p = product(product_id)
    if not p:
        raise LookupError("unknown option")
    values = profile(db, today)["values"]
    bills = _open_bills(db)
    top = limit(p, values, bills)
    if not p["min_minor"] <= amount <= max(top, p["min_minor"]) or not p["min_months"] <= months <= p["max_months"]:
        raise ValueError(f"Choose between {_money(p['min_minor'])} and {_money(max(top, p['min_minor']))}, over "
                         f"{p['min_months']} to {p['max_months']} months.")
    ok, why = eligibility(p, values, bills)
    fc = forecast.build(db, today)
    q = quote(p, amount, months, values, today + timedelta(days=1))
    eff = effect(fc, q.pop("flows"))
    return {"option_id": p["id"], "eligible": ok, "reasons": why, **q, **eff}


# ── Readiness ──────────────────────────────────────────────────────────────


def _books_up_to_date(db: Session) -> tuple[bool, str]:
    conn = db.execute(select(Connection).where(Connection.kind == "accounting")).scalar_one_or_none()
    if conn and conn.status == "connected" and conn.last_sync_at and \
            datetime.now(UTC) - conn.last_sync_at < timedelta(days=2):
        return True, "Your accounting software was read in the last 2 days."
    latest = db.execute(select(func.max(Record.date)).where(Record.status != "void")).scalar()
    if latest and (date.today() - latest).days <= 14:
        return True, "Your records include the last two weeks."
    return False, "Connect your accounting software or add recent bills and invoices."


def readiness(db: Session, values: dict) -> list[dict]:
    """What a lender usually looks at, and what would improve it. Not a credit score."""
    months = values.get("months_trading") or 0
    trend = values.get("sales_trend_pct")
    overdue = values.get("overdue_share") or 0
    cash_in = values.get("cash_in_monthly_minor") or 0
    repay = values.get("repayments_monthly_minor") or 0
    books_ok, books_note = _books_up_to_date(db)
    share = repay / cash_in if cash_in else 0
    return [
        {"id": "trading", "label": "Months trading", "value": f"{months} months", "ok": months >= 24,
         "tip": None if months >= 24 else "Many lenders want 2 years of trading; some accept 6 to 12 months."},
        {"id": "sales_trend", "label": "Sales trend", "ok": trend is not None and trend >= 0,
         "value": "Not enough history yet" if trend is None else f"{trend:+.1f}%",
         "tip": None if trend is not None and trend >= 0 else "Lenders look for steady or growing sales."},
        {"id": "overdue", "label": "Unpaid invoices over 30 days overdue", "value": f"{overdue * 100:.0f}%",
         "ok": overdue <= 0.2, "tip": None if overdue <= 0.2 else "Chase older invoices before you apply."},
        {"id": "repayments", "label": "Existing repayments against money coming in", "value": f"{share * 100:.0f}%",
         "ok": share <= 0.2, "tip": None if share <= 0.2 else "High existing repayments make new lending harder."},
        {"id": "books", "label": "Books up to date", "value": books_note, "ok": books_ok,
         "tip": None if books_ok else "Lenders ask for recent figures."},
        {"id": "profile", "label": "Profile complete", "ok": bool(values.get("industry") and values.get("business_type")),
         "value": "Industry and business type added" if values.get("industry") and values.get("business_type")
         else "Add your industry and business type",
         "tip": None if values.get("industry") and values.get("business_type") else "Lenders ask for these first."},
    ]
