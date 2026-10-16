"""Business health and why cash changed (docs/ALGORITHMS.md, sections 6 and 7).

Profit and loss is by month, before VAT:
  sales = invoices (by issue date) + card sales arriving as payouts (less the usual VAT share);
  costs = bills (by issue date) + purchases recorded in the books or kept as receipts
          + bank payments that no bill or purchase explains (payroll, rent, everyday spending).
Tax payments, loan repayments and transfers are not costs. A bank payment that is the same
money as a bill or a recorded purchase is counted once.
"""

import itertools
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Record
from . import forecast, ledger

MONTHS = 6
BUCKETS = (("Not yet due", None, 0), ("1–30 days overdue", 1, 30), ("31–60 days overdue", 31, 60),
           ("61–90 days overdue", 61, 90), ("Over 90 days overdue", 91, None))
COST_GROUPS = ("everyday", "salaries", "rent")


@dataclass
class Entry:
    day: date
    amount: int  # pence, before VAT where known
    side: str  # sales | costs
    category: str
    party: str
    record_id: str


def _month(d: date) -> date:
    return d.replace(day=1)


def _label(category: str | None) -> str:
    c = (category or "other").strip()
    return c[:1].upper() + c[1:]


def entries(db: Session, since: date, until: date) -> list[Entry]:
    """Every sale and cost between two dates, each counted once."""
    biz = ledger.business(db)
    names = ledger.names(db)
    rate = ledger.tax_rate(db)
    rows = db.execute(select(Record).where(Record.status != "void", Record.currency == biz.currency,
                                           Record.date >= since, Record.date <= until)).scalars().all()
    out: list[Entry] = []
    booked: list[tuple[int, date]] = []  # purchases and receipts, to spot the same payment at the bank
    for r in rows:
        who = names.get(r.counterparty_id) or ""
        if r.kind == "invoice":
            out.append(Entry(r.date, ledger.net(r), "sales", "sales", who, str(r.id)))
        elif r.kind == "bill":
            out.append(Entry(r.date, ledger.net(r), "costs", _label(r.category), who, str(r.id)))
        elif r.kind == "payment_out" and r.source != "plaid" and not r.external.get("linked") \
                and r.external.get("qbo_type") != "BillPayment":
            out.append(Entry(r.date, ledger.net(r), "costs", _label(r.category), who, str(r.id)))
            booked.append((r.amount_minor, r.date))
    lines = ledger.bank_lines(db, since=since, until=until)
    payouts = [ln for ln in lines if ln.group == "payout" or ln.linked_kind == "payout"]
    for ln in payouts:
        out.append(Entry(ln.record.date, round(ln.record.amount_minor / (1 + rate)), "sales", "card sales",
                         "Card sales", str(ln.record.id)))
    if not payouts:  # no bank feed: card payments straight from the payment platform
        for r in rows:
            if r.source == "stripe" and r.kind in ("payment_in", "refund") and not r.external.get("invoice"):
                sign = 1 if r.kind == "payment_in" else -1
                out.append(Entry(r.date, sign * round(r.amount_minor / (1 + rate)), "sales", "card sales",
                                 "Card sales", str(r.id)))
    for ln in lines:
        r = ln.record
        if ln.group not in COST_GROUPS or r.direction != "out":
            continue
        same = next((b for b in booked if b[0] == r.amount_minor and abs((b[1] - r.date).days) <= 3), None)
        if same:
            booked.remove(same)
            continue
        party = names.get(ln.party_id) or ledger._words(r.description).title()
        out.append(Entry(r.date, r.amount_minor, "costs", _label(ln.category), party, str(r.id)))
    return out


def profit_and_loss(db: Session, today: date, count: int = MONTHS) -> list[dict]:
    """The last six full months (or `count`), then this month so far."""
    start = forecast.add_months(_month(today), -count)
    months: dict = {forecast.add_months(start, i): {"sales": 0, "costs": 0} for i in range(count + 1)}
    for e in entries(db, start, today):
        months[_month(e.day)][e.side] += e.amount
    first = db.execute(select(func.min(Record.date)).where(Record.status != "void")).scalar()
    out = []
    for m, v in months.items():
        profit = v["sales"] - v["costs"]
        partial = m == _month(today) or not first or first > m  # our records start part-way through
        out.append({"month": m.isoformat()[:7], "label": f"{m:%b %Y}" + (" (so far)" if m == _month(today) else
                                                                           " (part)" if partial else ""),
                    "sales_minor": v["sales"], "costs_minor": v["costs"], "profit_minor": profit,
                    "margin_pct": round(profit / v["sales"] * 100, 1) if v["sales"] else None,
                    "complete": not partial})
    return out


def spending(db: Session, today: date, days: int = 90) -> tuple[list[dict], list[dict]]:
    """Where the money went in the last 90 days: by category, and the ten largest suppliers."""
    by_cat: dict = defaultdict(int)
    by_party: dict = defaultdict(int)
    for e in entries(db, today - timedelta(days=days), today):
        if e.side == "costs":
            by_cat[e.category] += e.amount
            by_party[e.party or "Other"] += e.amount
    cats = [{"category": c, "amount_minor": a} for c, a in sorted(by_cat.items(), key=lambda x: -x[1]) if a > 0]
    top = [{"name": n, "amount_minor": a} for n, a in sorted(by_party.items(), key=lambda x: -x[1])[:10] if a > 0]
    return cats, top


def who_owes_you(db: Session, today: date) -> dict:
    invoices, foreign = ledger.open_items(db, "invoice")
    terms = ledger.terms(db)
    buckets = {label: 0 for label, *_ in BUCKETS}
    overdue_30 = 0
    for r in invoices:
        late = (today - ledger.due(r, terms)).days
        for label, lo, hi in BUCKETS:
            if (lo is None and late <= 0) or (lo is not None and late >= lo and (hi is None or late <= hi)):
                buckets[label] += r.open_minor
        if late > 30:
            overdue_30 += r.open_minor
    total = sum(r.open_minor for r in invoices)
    return {"total_minor": total, "count": len(invoices),
            "overdue_minor": sum(r.open_minor for r in invoices if (today - ledger.due(r, terms)).days > 0),
            "over_30_share": round(overdue_30 / total, 3) if total else 0.0,
            "buckets": [{"bucket": k, "amount_minor": v} for k, v in buckets.items()],
            "other_currencies": len(foreign)}


def days_to_get_paid(db: Session, today: date) -> float | None:
    """Average days from invoice to payment over the last 90 days, weighted by amount."""
    rows = db.execute(select(Record).where(Record.kind == "invoice", Record.status == "paid",
                                           Record.paid_date >= today - timedelta(days=90),
                                           Record.paid_date <= today)).scalars().all()
    total = sum(r.amount_minor for r in rows)
    if not total:
        return None
    return round(sum((r.paid_date - r.date).days * r.amount_minor for r in rows) / total, 1)


def runway(db: Session, today: date) -> tuple[float | None, int]:
    """Months of cash at the last three months' rate, when more goes out than comes in."""
    lines = ledger.bank_lines(db, since=today - timedelta(days=90), until=today)
    net_flow = sum(ln.record.amount_minor * (1 if ln.record.direction == "in" else -1) for ln in lines)
    monthly = round(net_flow / 3)
    if monthly >= 0:
        return None, monthly
    return round(ledger.cash(db)["balance_minor"] / -monthly, 1), monthly


def _pct(new: int, old: int) -> float | None:
    return (new - old) / abs(old) * 100 if old else None


def checks(pnl: list[dict], owed: dict, months_left: float | None) -> list[dict]:
    full = [m for m in pnl if m["complete"]]
    out = []
    if len(full) >= 4:
        last = full[-4:]
        growth = [(_pct(b["costs_minor"], a["costs_minor"]), _pct(b["sales_minor"], a["sales_minor"]))
                  for a, b in itertools.pairwise(last)]
        if all(c is not None and s is not None and c > s for c, s in growth):
            out.append({"id": "costs-outgrowing-sales", "severity": "attention",
                        "sentence": "Costs have grown faster than sales for 3 months in a row.",
                        "why": "; ".join(f"{m['label']}: costs {c:+.0f}%, sales {s:+.0f}%"
                                         for m, (c, s) in zip(last[1:], growth, strict=False)) + "."})
    if len(full) >= 6:
        def margin(ms):
            sales = sum(m["sales_minor"] for m in ms)
            return (sales - sum(m["costs_minor"] for m in ms)) / sales * 100 if sales else None
        now, before = margin(full[-3:]), margin(full[-6:-3])
        if now is not None and before is not None and before - now > 5:
            out.append({"id": "margin-falling", "severity": "attention",
                        "sentence": f"Your margin has fallen by {before - now:.0f} points compared with the quarter before.",
                        "why": f"Margin was {before:.0f}% over {full[-6]['label']} to {full[-4]['label']} and "
                               f"{now:.0f}% over {full[-3]['label']} to {full[-1]['label']}."})
    if owed["over_30_share"] > 0.2:
        out.append({"id": "overdue-invoices", "severity": "attention",
                    "sentence": f"{owed['over_30_share'] * 100:.0f}% of what customers owe is over 30 days overdue.",
                    "why": "We flag this when more than 20% of unpaid invoices (by amount) are over 30 days late."})
    if months_left is not None and months_left < 3:
        out.append({"id": "short-runway", "severity": "urgent",
                    "sentence": f"At the current rate, cash lasts about {months_left:.1f} months.",
                    "why": "More has gone out than come in over the last three months."})
    return out


def summary(db: Session, today: date | None = None) -> dict:
    today = today or date.today()
    pnl = profit_and_loss(db, today)
    full = [m for m in pnl if m["complete"]][-3:]
    sales = sum(m["sales_minor"] for m in full)
    profit = sum(m["profit_minor"] for m in full)
    cats, top = spending(db, today)
    owed = who_owes_you(db, today)
    months_left, monthly_net = runway(db, today)
    return {
        "period_label": f"{full[0]['label']} to {full[-1]['label']}" if full else "",
        "sales_minor": sales,
        "profit_minor": profit,
        "margin_pct": round(profit / sales * 100, 1) if sales else 0.0,
        "days_to_get_paid": days_to_get_paid(db, today),
        "runway_months": months_left,
        "monthly_net_minor": monthly_net,
        "profit_and_loss": pnl,
        "spending": cats,
        "top_suppliers": top,
        "who_owes_you": owed["buckets"],
        "owed": owed,
        "checks": checks(pnl, owed, months_left),
    }


# ── Why cash changed ───────────────────────────────────────────────────────

WHY_GROUPS = {
    "customers": "Customer payments", "card": "Card sales",
    "suppliers": "Supplier costs", "salaries": "Salaries", "rent": "Rent", "tax": "Tax",
    "financing": "Financing", "one_off": "One-off items", "other": "Other",
}


def _periods(today: date, period: str) -> tuple[tuple[date, date], tuple[date, date]]:
    if period == "30d":
        cur = (today - timedelta(days=29), today)
        return cur, (cur[0] - timedelta(days=30), cur[0] - timedelta(days=1))
    start = _month(today)  # this month so far against the same days last month
    prev_start = forecast.add_months(start, -1)
    prev_end = min(forecast.add_months(prev_start, 0, today.day), start - timedelta(days=1))
    return (start, today), (prev_start, prev_end)


def _groups(db: Session, lines: list[ledger.Line], counts: dict, span: tuple[date, date]) -> tuple[dict, dict]:
    """Net money per group, and per payer or payee within each group."""
    totals: dict = defaultdict(int)
    items: dict = defaultdict(lambda: defaultdict(int))
    names = ledger.names(db)
    for ln in lines:
        r = ln.record
        if not span[0] <= r.date <= span[1]:
            continue
        signed = r.amount_minor if r.direction == "in" else -r.amount_minor
        if ln.group == "payout" or ln.linked_kind == "payout":
            g = "card"
        elif ln.group in ("tax", "financing", "salaries", "rent"):
            g = ln.group
        elif counts[ln.key] == 1 and r.amount_minor >= 250_00:
            g = "one_off"
        elif r.direction == "in":
            g = "customers"
        elif ln.group in ("settles", "everyday"):
            g = "suppliers"
        else:
            g = "other"
        totals[g] += signed
        label = "Card sales payouts" if g == "card" else names.get(ln.party_id) or ledger._words(r.description).title()
        items[g][label] += signed
    return totals, items


def why_cash_changed(db: Session, today: date | None = None, period: str = "month") -> dict:
    """Split the change in net cash flow between two periods into ranked reasons (section 7).
    The numbers only; the words are written from them and checked against them."""
    today = today or date.today()
    cur, prev = _periods(today, period)
    lines = ledger.bank_lines(db, since=today - timedelta(days=forecast.HISTORY_DAYS), until=today)
    counts: dict = defaultdict(int)
    for ln in lines:
        counts[ln.key] += 1
    biz = ledger.business(db)
    due_rows = db.execute(select(Record).where(Record.kind == "invoice", Record.status != "void",
                                               Record.currency == biz.currency)).scalars().all()
    terms = ledger.terms(db)

    def still_owed(span):
        """Invoices that fell due in the period and were not paid by its end: customer payment timing."""
        return sum(r.amount_minor for r in due_rows if span[0] <= ledger.due(r, terms) <= span[1]
                   and (r.paid_date is None or r.paid_date > span[1]))

    (t_cur, i_cur), (t_prev, i_prev) = _groups(db, lines, counts, cur), _groups(db, lines, counts, prev)
    net_cur, net_prev = sum(t_cur.values()), sum(t_prev.values())
    reasons = []
    for g, label in WHY_GROUPS.items():
        change = t_cur.get(g, 0) - t_prev.get(g, 0)
        if not change:
            continue
        keys = set(i_cur.get(g, {})) | set(i_prev.get(g, {}))
        top = sorted(((k, i_cur.get(g, {}).get(k, 0) - i_prev.get(g, {}).get(k, 0)) for k in keys),
                     key=lambda kv: -abs(kv[1]))[:3]
        reason = {"group": g, "label": label, "change_minor": change,
                  "this_period_minor": t_cur.get(g, 0), "last_period_minor": t_prev.get(g, 0),
                  "items": [{"label": k, "change_minor": v} for k, v in top if v]}
        if g == "customers":
            reason["late_this_period_minor"], reason["late_last_period_minor"] = still_owed(cur), still_owed(prev)
        reasons.append(reason)
    reasons.sort(key=lambda x: -abs(x["change_minor"]))
    change = net_cur - net_prev  # the reasons add up to exactly this
    return {
        "period": period,
        "this_period": {"from": cur[0].isoformat(), "to": cur[1].isoformat(), "net_minor": net_cur},
        "last_period": {"from": prev[0].isoformat(), "to": prev[1].isoformat(), "net_minor": net_prev},
        "change_minor": change,
        "reasons": reasons,
        "sentence": _why_sentence(change, reasons, cur, prev),
    }


def _why_sentence(change: int, reasons: list[dict], cur, prev) -> str:
    if not reasons:
        return "Cash moved the same way in both periods."
    which = "better" if change > 0 else "worse"
    top = [r for r in reasons[:3] if (r["change_minor"] > 0) == (change > 0)] or reasons[:1]
    parts = [f"{r['label'].lower()} ({'+' if r['change_minor'] > 0 else '−'}£{abs(r['change_minor']) / 100:,.2f})"
             for r in top]
    return (f"From {cur[0]:%-d %b} to {cur[1]:%-d %b}, cash did £{abs(change) / 100:,.2f} {which} than "
            f"{prev[0]:%-d %b} to {prev[1]:%-d %b}. The main reasons: {', '.join(parts)}.")

