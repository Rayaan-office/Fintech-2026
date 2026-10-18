"""The assistant's tools (docs/ALGORITHMS.md, section 12). A fixed list, each read-only.

Each tool runs our own calculations inside a read-only transaction that sees one business, and
returns three things:
  facts   - short labelled values for the AI, written as money, percentages and dates
  blocks  - a chart or table for the app, built by our code (never by the AI)
  sources - the records behind the answer, so any number can be traced
Names in the facts are replaced with placeholders before the AI sees them (wording.prepare).
"""

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from ..analytics import financing, forecast, health, ledger, rules
from ..models import Recommendation, Record
from ..privacy.detectors import detect
from ..privacy.redact import restore
from ..security.rbac import Perm
from . import passages
from .wording import Names, day, money

MAX_MINOR = 100_000_000_00


@dataclass
class Result:
    facts: dict
    blocks: list = field(default_factory=list)
    sources: list = field(default_factory=list)


@dataclass(frozen=True)
class Tool:
    name: str
    about: str  # what it answers, shown to the AI when it picks tools
    perm: str
    fn: object


def _short(d: str | date) -> str:
    d = date.fromisoformat(d) if isinstance(d, str) else d
    return f"{d.day} {d:%b}"


def cash_forecast(db: Session, today: date, **_) -> Result:
    fc = forecast.build(db, today)
    soon = [it for it in fc["items"] if it["amount_minor"] < 0 and it["expected"]
            and it["expected"] <= (today + timedelta(days=30)).isoformat()]
    soon.sort(key=lambda it: it["amount_minor"])
    money_in = sum(it["amount_minor"] for it in fc["items"] if it["amount_minor"] > 0 and it["expected"]
                   and it["expected"] <= (today + timedelta(days=30)).isoformat())
    facts = {"cash today": money(fc["balance_minor"]),
             **{f"expected cash in {n} days": money(fc["horizons"][n]) for n in ("7", "30", "60", "90")},
             "lowest expected point": f"{money(fc['lowest']['balance_minor'])} on {day(date.fromisoformat(fc['lowest']['date']))}",
             "worst case lowest point": f"{money(fc['worst_lowest']['balance_minor'])} on "
                                        f"{day(date.fromisoformat(fc['worst_lowest']['date']))}",
             "safety level": money(fc["safety_level_minor"]),
             "known money in over the next 30 days": money(money_in),
             "biggest payments out in the next 30 days": [f"{it['label']}: {money(-it['amount_minor'])} on "
                                                          f"{day(date.fromisoformat(it['expected']))}" for it in soon[:5]],
             "warnings": [w["sentence"] for w in fc["warnings"]] or "none"}
    weekly = fc["series"][::7]
    blocks = [{"type": "chart", "kind": "forecast", "title": "Cash forecast, next 90 days",
               "safety_level_minor": fc["safety_level_minor"],
               "points": [{"date": p["date"], "expected_minor": p["expected_minor"], "best_minor": p["best_minor"],
                           "worst_minor": p["worst_minor"]} for p in weekly]}]
    return Result(facts, blocks, [{"id": "cash-flow", "kind": "page", "label": "Cash flow", "href": "/cash-flow"}])


def business_health(db: Session, today: date, **_) -> Result:
    h = health.summary(db, today)
    facts = {"period": h["period_label"], "sales in the period (before VAT)": money(h["sales_minor"]),
             "profit in the period": money(h["profit_minor"]), "margin": f"{h['margin_pct']:.1f}%",
             "days to get paid": f"{h['days_to_get_paid']:.0f}" if h["days_to_get_paid"] is not None else "not known",
             "cash runway": f"{h['runway_months']} months" if h["runway_months"] is not None
             else "more comes in than goes out",
             "months": [f"{m['label']}: sales {money(m['sales_minor'])}, costs {money(m['costs_minor'])}, "
                        f"profit {money(m['profit_minor'])}" for m in h["profit_and_loss"]],
             "biggest spending categories (90 days)": [f"{c['category']}: {money(c['amount_minor'])}"
                                                       for c in h["spending"][:5]],
             "biggest suppliers (90 days)": [f"{s['name']}: {money(s['amount_minor'])}" for s in h["top_suppliers"][:5]],
             "health checks": [c["sentence"] for c in h["checks"]] or "none raised"}
    blocks = [{"type": "table", "title": "Profit and loss by month (before VAT)",
               "columns": ["Month", "Sales", "Costs", "Profit"],
               "rows": [[m["label"], m["sales_minor"], m["costs_minor"], m["profit_minor"]] for m in h["profit_and_loss"]],
               "money_columns": [1, 2, 3]}]
    return Result(facts, blocks, [{"id": "health", "kind": "page", "label": "Business health", "href": "/health"}])


def who_owes_you(db: Session, today: date, **_) -> Result:
    invoices, _ = ledger.open_items(db, "invoice")
    names, terms = ledger.names(db), ledger.terms(db)
    late = forecast.lateness(db, today)
    by: dict = defaultdict(lambda: {"owed": 0, "overdue": 0, "count": 0})
    for r in invoices:
        b = by[r.counterparty_id]
        b["owed"] += r.open_minor
        b["count"] += 1
        if ledger.due(r, terms) < today:
            b["overdue"] += r.open_minor
    rows = sorted(by.items(), key=lambda kv: -kv[1]["owed"])
    owed = health.who_owes_you(db, today)
    facts = {"total owed": money(owed["total_minor"]), "of which overdue": money(owed["overdue_minor"]),
             "unpaid invoices": owed["count"],
             "by how overdue": [f"{b['bucket']}: {money(b['amount_minor'])}" for b in owed["buckets"] if b["amount_minor"]],
             "customers": [f"{names.get(cid) or 'Unnamed customer'}: owes {money(v['owed'])} on {v['count']} invoice(s), "
                           f"{money(v['overdue'])} overdue"
                           + (f"; usually pays {late[cid][0]:.0f} days after the due date" if cid in late
                              and late[cid][2] >= 3 else "") for cid, v in rows[:8]]}
    blocks = [{"type": "table", "title": "Who owes you", "columns": ["Customer", "Owed", "Overdue"],
               "rows": [[names.get(cid) or "Unnamed customer", v["owed"], v["overdue"]] for cid, v in rows[:8]],
               "money_columns": [1, 2]}]
    sources = [{"id": str(r.id), "kind": "invoice", "label": f"Invoice {r.reference or ''}".strip()}
               for r in sorted(invoices, key=lambda r: -r.open_minor)[:5]]
    return Result(facts, blocks, sources)


def supplier_history(db: Session, today: date, party_id=None, **_) -> Result:
    names = ledger.names(db)
    biz = ledger.business(db)
    since = today - timedelta(days=182)
    q = select(Record).where(Record.kind == "bill", Record.status != "void", Record.currency == biz.currency,
                             Record.date >= since)
    if party_id:
        q = q.where(Record.counterparty_id == party_id)
    bills = db.execute(q.order_by(Record.date)).scalars().all()
    if party_id:
        months: dict = defaultdict(int)
        for b in bills:
            months[b.date.replace(day=1)] += b.amount_minor
        rises = [f for f in rules.price_rises(db, today) if f.counterparty_id == party_id]
        facts = {"supplier": names.get(party_id, "This supplier"), "bills in the last 6 months": len(bills),
                 "billed each month": [f"{m:%B %Y}: {money(v)}" for m, v in sorted(months.items())],
                 "latest bill": f"{money(bills[-1].amount_minor)} on {day(bills[-1].date)}" if bills else "none",
                 "price rise found": rises[0].body if rises else "no rise of 10% or more found"}
        rows = [[f"{m:%b %Y}", v] for m, v in sorted(months.items())]
        title = f"Bills from {names.get(party_id, 'this supplier')}"
    else:
        recent, before = defaultdict(int), defaultdict(int)
        for b in bills:
            (recent if b.date > today - timedelta(days=91) else before)[b.counterparty_id] += b.amount_minor
        top = sorted(recent.items(), key=lambda kv: -kv[1])[:8]
        facts = {"suppliers by bills in the last 90 days": [
            f"{names.get(cid) or 'Unnamed supplier'}: {money(v)} (the 90 days before: {money(before.get(cid, 0))})"
            for cid, v in top],
            "price rises found (10% or more, by bill or price per unit)": [f.body for f in rules.price_rises(db, today)]
            or "none"}
        rows = [[names.get(cid) or "Unnamed supplier", v, before.get(cid, 0)] for cid, v in top]
        title = "Suppliers, last 90 days against the 90 before"
    cols = ["Month", "Billed"] if party_id else ["Supplier", "Last 90 days", "90 days before"]
    blocks = [{"type": "table", "title": title, "columns": cols, "rows": rows,
               "money_columns": [1] if party_id else [1, 2]}]
    sources = [{"id": str(b.id), "kind": "bill", "label": f"Bill {b.reference or ''}".strip()} for b in bills[-5:]]
    return Result(facts, blocks, sources)


def why_cash_changed(db: Session, today: date, period: str | None = None, **_) -> Result:
    w = health.why_cash_changed(db, today, period=period if period in ("month", "30d") else "month")
    facts = {"this period": f"{_short(w['this_period']['from'])} to {_short(w['this_period']['to'])}",
             "net cash flow this period": money(w["this_period"]["net_minor"]),
             "compared with": f"{_short(w['last_period']['from'])} to {_short(w['last_period']['to'])}",
             "net cash flow then": money(w["last_period"]["net_minor"]),
             "change": money(w["change_minor"]),
             "reasons, largest first (positive means more cash than last period)": [
                 f"{r['label']}: {money(r['change_minor'])}" + (" (" + "; ".join(
                     f"{i['label']} {money(i['change_minor'])}" for i in r["items"]) + ")" if r["items"] else "")
                 for r in w["reasons"][:6]]}
    blocks = [{"type": "table", "title": "Why cash changed", "columns": ["Reason", "Change"],
               "rows": [[r["label"], r["change_minor"]] for r in w["reasons"][:6]], "money_columns": [1]}]
    return Result(facts, blocks, [{"id": "why", "kind": "page", "label": "Why cash changed", "href": "/cash-flow"}])


def what_if(db: Session, today: date, amount_minor: int | None = None, on: date | None = None,
            repeat: str | None = None, label: str | None = None, **_) -> Result:
    if not amount_minor or amount_minor <= 0 or amount_minor > MAX_MINOR:
        return Result({"what if": "The question did not give an amount, so nothing was calculated."})
    on = on if on and today < on <= today + timedelta(days=366) else today + timedelta(days=30)
    plan = {"label": (label or "Planned cost")[:120], "amount_minor": amount_minor, "date": on,
            "repeat": repeat if repeat in ("none", "weekly", "monthly") else "none", "direction": "out"}
    w = forecast.what_if(db, [plan], [], {}, today)["what_if"]
    facts = {"planned cost": f"{money(amount_minor)} on {day(on)}" + (f", repeating {plan['repeat']}"
                                                                         if plan["repeat"] != "none" else ""),
             "lowest cash before": f"{money(w['lowest_before']['balance_minor'])} on "
                                   f"{day(date.fromisoformat(w['lowest_before']['date']))}",
             "lowest cash after": f"{money(w['lowest_after']['balance_minor'])} on "
                                  f"{day(date.fromisoformat(w['lowest_after']['date']))}",
             "worst case lowest after": money(w["worst_lowest_after"]["balance_minor"]),
             "goes below the safety level": "yes" if w["below_safety"] else "no",
             "missing at the lowest point": money(w["shortfall_minor"]) if w["shortfall_minor"] else "nothing"}
    return Result(facts, [], [{"id": "what-if", "kind": "page", "label": "Try it on the cash flow page",
                               "href": "/cash-flow"}])


def financing_options(db: Session, today: date, amount_minor: int | None = None, **_) -> Result:
    o = financing.options(db, today, amount=amount_minor if amount_minor and 0 < amount_minor <= MAX_MINOR else None)
    g = o["gap"]
    top = [x for x in o["options"] if x["eligible"] and x.get("quote")][:3]
    facts = {"forecast shortfall": f"{money(g['amount_minor'])} from {day(date.fromisoformat(g['starts_on']))} for "
                                   f"about {g['days']} days" if g else "none in the next 90 days",
             "amount looked at": money(o["need"]["amount_minor"]) if o["need"]["amount_minor"] else "none",
             "options": [f"{x['product']} ({x['provider']}): costs {money(x['quote']['total_cost_minor'])} in total, "
                         f"{money(x['quote']['monthly_repayment_minor'])} a month; {x['quote']['forecast_effect']}"
                         for x in top] or "none that fit",
             "not available yet": [f"{x['product']}: {x['eligibility_note']}" for x in o["options"]
                                   if not x["eligible"]][:3],
             "readiness to improve": [f"{r['label']}: {r['tip']}" for r in o["readiness"] if not r["ok"]] or "none",
             "note": "Sample providers and rates; information, not advice."}
    blocks = [{"type": "table", "title": "Financing options", "columns": ["Option", "Total cost", "A month"],
               "rows": [[x["product"], x["quote"]["total_cost_minor"], x["quote"]["monthly_repayment_minor"]]
                        for x in top], "money_columns": [1, 2]}]
    return Result(facts, blocks, [{"id": "financing", "kind": "page", "label": "Financing", "href": "/financing"}])


def recommendations(db: Session, today: date, **_) -> Result:
    recs = db.execute(select(Recommendation).where(Recommendation.status == "new")
                      .order_by(Recommendation.score.desc()).limit(5)).scalars().all()
    facts = {"open recommendations": [f"{r.title}: {r.body}" for r in recs] or "none right now"}
    return Result(facts, [], [{"id": str(r.id), "kind": "recommendation", "label": r.title,
                               "href": f"/recommendations?open={r.id}"} for r in recs])


# Ask anything: our own query over an allowlist of record kinds and columns, and document search.
# The AI only fills in the choices below; it never writes SQL.
KINDS = {
    "sales_invoices": ("Sales invoices", "invoices", and_(Record.kind == "invoice")),
    "bills": ("Bills", "bills", and_(Record.kind == "bill")),
    "money_in": ("Money in at the bank", "payments in", and_(Record.kind == "bank_txn", Record.direction == "in")),
    "money_out": ("Money out at the bank", "payments out", and_(Record.kind == "bank_txn", Record.direction == "out")),
    "fees": ("Payment platform fees", "fees", and_(Record.kind == "fee")),
}
_RECORD_LABEL = {"invoice": "Invoice", "bill": "Bill", "bank_txn": "Bank payment", "fee": "Fee"}
MAX_ROWS = 24
MAX_MONTHS = 24
_CATEGORY = re.compile(r"^[A-Za-z][A-Za-z &/,'()-]{1,39}$")


def known_categories(db: Session, names) -> list[str]:
    """The categories in use, for the AI to pick from: plain words only, never a name or detail."""
    rows = db.execute(select(Record.category).where(Record.category.is_not(None)).distinct()
                      .order_by(Record.category).limit(60)).scalars().all()
    cats = [c for c in rows if _CATEGORY.match(c) and names.hide(c) == c]
    joined = "; ".join(cats)
    hits = detect(joined, people=True)
    out, pos = [], 0
    for c in cats:
        if not any(h.start < pos + len(c) and pos < h.end for h in hits):
            out.append(c)
        pos += len(c) + 2
    return out


def _span(today: date, start: date | None, end: date | None) -> tuple[date, date, bool]:
    end = end or today
    start = start or forecast.add_months(end.replace(day=1), -11)
    start, end = min(start, end), max(start, end)
    earliest = forecast.add_months(end, -MAX_MONTHS)
    return max(start, earliest), end, start < earliest


def query_records(db: Session, today: date, kind: str | None = None, party_id=None, category: str | None = None,
                  from_date: date | None = None, to_date: date | None = None, group_by: str | None = None,
                  measure: str | None = None, names=None, party_unknown: bool = False, **_) -> Result:
    if party_unknown:
        return Result({"records": "The supplier or customer asked about is not one we know, so nothing was counted."})
    names = names or Names(db)
    title, noun, where = KINDS.get(kind or "", KINDS["bills"])
    group_by = group_by if group_by in ("month", "category", "party") else "none"
    measure = measure if measure in ("total", "count", "average") else "total"
    start, end, clipped = _span(today, from_date, to_date)
    biz = ledger.business(db)
    filters = [where, Record.status != "void", Record.currency == biz.currency, Record.date >= start,
               Record.date <= end]
    if party_id:
        filters.append(Record.counterparty_id == party_id)
    if category:
        filters.append(func.lower(Record.category) == category.strip().lower()[:80])
    total, count = db.execute(select(func.coalesce(func.sum(Record.amount_minor), 0), func.count(Record.id))
                              .where(*filters)).one()
    total = int(total)  # a sum of whole pence comes back as a Decimal
    group = {"month": func.date_trunc("month", Record.date), "category": func.coalesce(Record.category, "uncategorised"),
             "party": Record.counterparty_id, "none": None}[group_by]
    rows: list = []
    if group is not None:
        amount, n = func.sum(Record.amount_minor), func.count(Record.id)
        order = group if group_by == "month" else (n.desc() if measure == "count" else amount.desc())
        rows = [(g, int(a), c) for g, a, c in db.execute(select(group, amount, n).where(*filters).group_by(group)
                                                         .order_by(order).limit(MAX_ROWS + 1)).all()]

    real_names = ledger.names(db) if group_by == "party" else {}

    def label(g, real: bool) -> str:
        if group_by == "month":
            return f"{g:%B %Y}"
        if group_by == "party":
            return (real_names.get(g) if real else names.of(g)) or "No supplier or customer"
        return str(g)

    def line(lbl: str, amount: int, n: int) -> str:
        if measure == "count":
            return f"{lbl}: {n} {noun}"
        if measure == "average":
            return f"{lbl}: average {money(round(amount / n)) if n else money(0)} over {n} {noun}"
        return f"{lbl}: {money(amount)} from {n} {noun}"

    facts = {"what was counted": f"{title.lower()}" + (" (including VAT)" if kind in ("sales_invoices", "bills")
                                                        else "") + " in the business currency",
             "from": day(start), "to": day(end),
             **({"limited to": f"the last {MAX_MONTHS} months"} if clipped else {}),
             **({"supplier or customer": names.of(party_id) or "the one asked about"} if party_id else {}),
             **({"category": category.strip()[:80]} if category else {}),
             "all together": line("all together", total, count)}
    by = {"party": "by supplier or customer"}.get(group_by, f"by {group_by}")
    if rows:
        facts[by] = [line(label(g, False), a, n) for g, a, n in rows[:MAX_ROWS]]
        if len(rows) > MAX_ROWS:
            facts["note"] = f"only the first {MAX_ROWS} groups are listed"
    shown = rows[:MAX_ROWS] if rows else [("All", total, count)]
    blocks = [{"type": "table", "title": title + (f" {by}" if rows else "")
               + f", {_short(start)} {start:%Y} to {_short(end)} {end:%Y}",
               "columns": [{"month": "Month", "category": "Category", "party": "Supplier or customer"}.get(group_by, ""),
                           "Total", "Number", "Average"],
               "rows": [[label(g, True) if rows else g, a, n, round(a / n) if n else 0] for g, a, n in shown],
               "money_columns": [1, 3]}]
    biggest = db.execute(select(Record).where(*filters).order_by(Record.amount_minor.desc()).limit(5)).scalars().all()
    sources = [{"id": str(r.id), "kind": r.kind, "label": f"{_RECORD_LABEL.get(r.kind, 'Record')} "
                f"{r.reference or day(r.date)}"[:80]} for r in biggest]
    return Result(facts, blocks, sources)


def search_documents(db: Session, today: date, search: str | None = None, party_id=None, names=None, **_) -> Result:
    names = names or Names(db)
    words = passages.search_words(search)
    if not words:
        return Result({"document search": "The question did not give any words to look for."})
    found = passages.find(db, words, names, party_id=party_id)
    facts = {"searched documents for": words, "documents found": len(found) or "none",
             "passages (personal details are shown as [hidden ...])": [
                 f"{(p.document.doc_type or 'document').replace('_', ' ')}"
                 + (f" from {names.of(p.document.counterparty_id)}" if names.of(p.document.counterparty_id) else "")
                 + f", received {day(p.document.created_at)}: \"{p.text}\"" for p in found] or "none"}
    items = [{"document_id": str(p.document.id), "label": p.document.filename[:120],
              "kind": (p.document.doc_type or "document").replace("_", " "),
              "date": p.document.created_at.date().isoformat(), "text": restore(p.text, names.real),
              "href": f"/documents?open={p.document.id}"} for p in found]
    blocks = [{"type": "passages", "title": "From your documents", "items": items}] if items else []
    sources = [{"id": i["document_id"], "kind": "document", "label": i["label"], "href": i["href"]} for i in items]
    return Result(facts, blocks, sources)


TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool("cash_forecast", "cash today and the 90-day forecast, lowest point, upcoming payments, warnings",
         Perm.VIEW_ALL, cash_forecast),
    Tool("business_health", "profit and loss by month, margin, spending by category, top suppliers, runway",
         Perm.VIEW_ALL, business_health),
    Tool("who_owes_you", "unpaid invoices by customer, how overdue, and how late each customer usually pays",
         Perm.VIEW_ALL, who_owes_you),
    Tool("supplier_history", "bills from one supplier (give its placeholder) or all suppliers over 6 months, "
         "and any price rise", Perm.VIEW_ALL, supplier_history),
    Tool("why_cash_changed", "why cash is up or down this month against last month (period month or 30d)",
         Perm.VIEW_ALL, why_cash_changed),
    Tool("what_if", "the forecast with a planned cost added (amount, date, repeat)", Perm.VIEW_ALL, what_if),
    Tool("financing_options", "how to cover a shortfall: financing options, cost and readiness",
         Perm.USE_FINANCING, financing_options),
    Tool("recommendations", "things worth looking at that our checks found", Perm.VIEW_ALL, recommendations),
    Tool("query_records", "totals, counts or averages from the records for questions the other tools don't cover: "
         "kind (sales_invoices, bills, money_in, money_out, fees), optionally one party placeholder or one known "
         "category, from_date and to_date (at most 24 months), group_by (month, category, party or none) and "
         "measure (total, count or average)", Perm.VIEW_ALL, query_records),
    Tool("search_documents", "what the bills, receipts and letters we have read say about something: give a few "
         "search words, and optionally a party placeholder", Perm.REVIEW_DOCUMENTS, search_documents),
]}
