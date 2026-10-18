"""Cash forecast for the next 90 days, early warnings and what-if (docs/ALGORITHMS.md, sections 4, 5 and 8).

Built day by day from:
  1. cash today across connected accounts;
  2. unpaid invoices, each on the day that customer usually pays (their past lateness);
  3. unpaid bills on their due dates (already overdue: we assume they are paid now);
  4. repeating items (rent, payroll, card-sales payouts, regular suppliers and customers), spotted
     because the same party moves a similar amount at a regular interval; a regular supplier or
     customer is projected only after the dates its unpaid bills or invoices already cover;
  5. VAT, estimated from the VAT on invoices and bills when no regular VAT payment is seen yet;
  6. the everyday pattern: the usual net in or out for each day of the week, for everything else;
  7. planned costs the owner has added (what-if), which never change real records.

Best and worst case: customers pay as early or as late as they have before, and everyday
activity and varying repeating amounts move by their past spread (an 80% range).
"""

import calendar
import itertools
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import PlannedItem, Record
from . import ledger

HORIZON = 90
HISTORY_DAYS = 182
EVERYDAY_WEEKS = 12
Z = 1.28  # 80% of outcomes fall inside the band
DOUBTFUL_DAYS = 60  # invoices this far overdue are left out of the expected case
SAFETY_DAYS = 14  # default safety level: two weeks of usual spending
PERIODS = {"week": (7, 2), "fortnight": (14, 3), "month": (30, 5), "quarter": (91, 10)}


@dataclass
class Item:
    id: str
    label: str
    kind: str  # invoice | bill | repeating | tax | planned
    amount: int  # + money in, - money out
    expected: date | None  # None: left out of that case
    best: date | None = None
    worst: date | None = None
    movable: bool = False
    why: str = ""
    record_ids: list = field(default_factory=list)
    party_id: object = None

    def on(self, case: str) -> date | None:
        return {"expected": self.expected, "best": self.best, "worst": self.worst}[case]


@dataclass
class Stream:
    key: str
    label: str
    period: str
    last: date
    amount: int  # signed
    spread: int  # spread of one occurrence
    count: int
    party_id: object = None
    group: str = ""  # invoice | bill for regular customers and suppliers; else the bank line group
    due_days: int = 0  # invoice or bill to due date


def add_months(d: date, n: int, day: int | None = None) -> date:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(day or d.day, calendar.monthrange(y, m)[1]))


def _money(minor: int) -> str:
    return f"£{abs(minor) / 100:,.2f}"


def _day(d: date) -> str:
    return f"{d.day} {d:%B}"


# ── Customers' payment habits ──────────────────────────────────────────────


def lateness(db: Session, today: date) -> dict:
    """Per customer: (average days paid after the due date, spread in days, invoices seen)."""
    terms = ledger.terms(db)
    rows = db.execute(select(Record).where(Record.kind == "invoice", Record.status == "paid",
                                           Record.paid_date.is_not(None),
                                           Record.date >= today - timedelta(days=365))).scalars().all()
    paid = [(r, r.paid_date) for r in rows] + [(r, on) for r, on in ledger.settled_short(db)
                                                if r.date >= today - timedelta(days=365)]
    days: dict = defaultdict(list)
    for r, on in paid:
        days[r.counterparty_id].append((on - ledger.due(r, terms)).days)
    out = {cp: (statistics.fmean(v), statistics.pstdev(v) if len(v) > 1 else 3.0, len(v)) for cp, v in days.items()}
    every = [x for v in days.values() for x in v]
    out[None] = (statistics.fmean(every), statistics.pstdev(every) if len(every) > 1 else 3.0, len(every)) \
        if every else (0.0, 3.0, 0)
    return out


def _invoice_items(db: Session, today: date, late: dict, names: dict, terms: dict) -> list[Item]:
    items = []
    invoices, _ = ledger.open_items(db, "invoice")
    for r in invoices:
        mean, sd, seen = late.get(r.counterparty_id) or late[None]
        spread = max(2, round(sd))
        d_due = ledger.due(r, terms)
        expect = d_due + timedelta(days=round(mean))
        who = names.get(r.counterparty_id) or "A customer"
        ref = f" {r.reference}" if r.reference else ""
        habit = (f"{who} usually pays {_days(round(mean))} after the due date" if seen and round(mean) > 0 else
                 f"{who} usually pays on time" if seen else "No payment history yet, so we use your customers' average")
        if (today - d_due).days > DOUBTFUL_DAYS:
            it = Item(f"invoice:{r.id}", f"{who} invoice{ref}", "invoice", r.open_minor, None, today + timedelta(days=7),
                      None, why=f"Over {DOUBTFUL_DAYS} days overdue, so only counted in the best case")
        elif expect <= today:
            it = Item(f"invoice:{r.id}", f"{who} invoice{ref}", "invoice", r.open_minor,
                      today + timedelta(days=min(spread, 7)), today + timedelta(days=1), today + timedelta(days=14),
                      why=f"Overdue since {_day(d_due)}; {habit.lower() if habit[0] == 'N' else habit}")
        else:
            it = Item(f"invoice:{r.id}", f"{who} invoice{ref}", "invoice", r.open_minor, expect,
                      max(today + timedelta(days=1), expect - timedelta(days=spread)), expect + timedelta(days=spread),
                      why=f"Due {_day(d_due)}; {habit}")
        it.record_ids, it.party_id = [str(r.id)], r.counterparty_id
        items.append(it)
    return items


def _bill_items(db: Session, today: date, names: dict, terms: dict) -> list[Item]:
    items = []
    bills, _ = ledger.open_items(db, "bill")
    for r in bills:
        d_due = ledger.due(r, terms)
        when = max(d_due, today + timedelta(days=1))
        who = names.get(r.counterparty_id) or "A supplier"
        ref = f" {r.reference}" if r.reference else ""
        why = f"Due {_day(d_due)}" if d_due > today else f"Overdue since {_day(d_due)}, so we assume it is paid now"
        items.append(Item(f"bill:{r.id}", f"{who} bill{ref}", "bill", -r.open_minor, when, when, when, movable=True,
                          why=why, record_ids=[str(r.id)], party_id=r.counterparty_id))
    return items


# ── Repeating items and the everyday pattern ───────────────────────────────


def _period(gaps: list[int]) -> str | None:
    if not gaps:
        return None
    med = statistics.median(gaps)
    for name, (days, tol) in PERIODS.items():
        if abs(med - days) <= tol:
            regular = sum(abs(g - days) <= tol for g in gaps) / len(gaps)
            return name if regular >= 0.7 else None
    return None


def streams(lines: list[ledger.Line], today: date, names: dict) -> dict[str, Stream]:
    """Payers and payees that repeat at a regular interval and are still active."""
    by_key: dict = defaultdict(list)
    for ln in lines:
        if ln.group in ("transfer", "settles"):  # money for invoices and bills: see book_streams
            continue
        by_key[ln.key].append(ln)
    out = {}
    for key, group in by_key.items():
        group.sort(key=lambda ln: ln.record.date)
        dates = [ln.record.date for ln in group]
        # several lines on one day (two invoices paid together) count as one occurrence
        days = sorted(set(dates))
        per_day = [sum(ln.record.amount_minor for ln in group if ln.record.date == d) for d in days]
        period = _period([(b - a).days for a, b in itertools.pairwise(days)])
        need = 2 if period == "quarter" else 3
        if not period or len(days) < need:
            continue
        p_days = PERIODS[period][0]
        if (today - days[-1]).days > p_days * 1.5 + 3:
            continue  # stopped
        recent = per_day[-6:]
        amount = recent[-1] if len(recent) >= 3 and recent[-3] < recent[-2] < recent[-1] else round(statistics.median(recent))
        sign = 1 if group[0].record.direction == "in" else -1
        first = group[-1]
        label = "Card sales payout" if first.group == "payout" else ledger._words(first.record.description).title()
        out[key] = Stream(key, label, period, days[-1], sign * amount,
                          round(statistics.pstdev(recent)) if len(recent) > 1 else 0, len(days), None, first.group)
    return out


def _cadence(days: list[date], per_day: list[int], today: date) -> tuple[str, int, int] | None:
    """(period, usual amount, spread) if these dates repeat regularly and are still going."""
    period = _period([(b - a).days for a, b in itertools.pairwise(days)])
    if not period or len(days) < (2 if period == "quarter" else 3):
        return None
    if (today - days[-1]).days > PERIODS[period][0] * 1.5 + 3:
        return None  # stopped
    recent = per_day[-6:]
    amount = recent[-1] if len(recent) >= 3 and recent[-3] < recent[-2] < recent[-1] else round(statistics.median(recent))
    return period, amount, round(statistics.pstdev(recent)) if len(recent) > 1 else 0


def book_streams(db: Session, today: date, names: dict) -> dict[str, Stream]:
    """Customers invoiced, and suppliers billing, at a regular interval. Their payments wander by a
    few days at the bank, but the invoices and bills themselves keep a steady rhythm."""
    biz = ledger.business(db)
    rows = db.execute(select(Record).where(
        Record.kind.in_(("invoice", "bill")), Record.status != "void", Record.currency == biz.currency,
        Record.counterparty_id.is_not(None), Record.date >= today - timedelta(days=HISTORY_DAYS))).scalars().all()
    by_party: dict = defaultdict(list)
    for r in rows:
        by_party[(r.kind, r.counterparty_id)].append(r)
    out = {}
    for (kind, cp), group in by_party.items():
        days = sorted({r.date for r in group})
        found = _cadence(days, [sum(r.amount_minor for r in group if r.date == d) for d in days], today)
        if not found:
            continue
        period, amount, spread = found
        offset = round(statistics.median([(r.due_date - r.date).days for r in group if r.due_date] or [30]))
        out[f"{kind}:{cp}"] = Stream(f"{kind}:{cp}", names.get(cp) or "", period, days[-1],
                                     amount if kind == "invoice" else -amount, spread, len(days), cp, kind,
                                     offset)
    return out


def _next(s: Stream, after: date, until: date) -> list[date]:
    out, n = [], 1
    while True:
        if s.period in ("month", "quarter"):
            d = add_months(s.last, n * (1 if s.period == "month" else 3))
        else:
            d = s.last + timedelta(days=n * PERIODS[s.period][0])
        if d > until:
            return out
        if d > after:
            out.append(d)
        n += 1


def _stream_items(found: dict[str, Stream], today: date, end: date, late: dict, platform_minor: int) -> list[Item]:
    items = []
    held = platform_minor  # card sales already in the platform balance arrive with the next payouts
    for s in sorted(found.values(), key=lambda s: s.key):
        if s.group in ("invoice", "bill"):  # the next invoices or bills, paid after their usual delay
            mean, sd, _ = (late.get(s.party_id) or late[None]) if s.group == "invoice" else (0.0, 0.0, 0)
            delay = s.due_days + round(mean)
            spread = max(2, round(sd)) if s.group == "invoice" else 0
            word = "Invoiced" if s.group == "invoice" else "Bills"
            for issued in _next(s, s.last, end):
                d = max(issued + timedelta(days=delay), today + timedelta(days=1))
                if d > end:
                    break
                items.append(Item(
                    f"repeat:{s.key}:{issued.isoformat()}", f"{s.label} ({'next invoice' if s.group == 'invoice' else 'next bill'})",
                    "repeating", s.amount, d, max(today + timedelta(days=1), d - timedelta(days=spread)),
                    d + timedelta(days=spread), party_id=s.party_id,
                    why=f"{word} every {s.period} ({s.count} times so far), usually {_money(s.amount)}; "
                        f"paid about {_days(delay)} after"))
            continue
        for d in _next(s, today, end):
            amount = s.amount
            why = f"Every {s.period} ({s.count} times so far), usually {_money(s.amount)}"
            if s.group == "payout" and held > 0:
                use = min(held, amount)
                amount -= use
                held -= use
                why += f"; {_money(use)} of it is already in your payment-platform balance"
            if amount:
                items.append(Item(f"repeat:{s.key}:{d.isoformat()}", s.label, "repeating", amount, d, d, d, why=why))
    return items


def _days(n: int) -> str:
    return f"{n} day" if abs(n) == 1 else f"{n} days"


def everyday(lines: list[ledger.Line], found: dict[str, Stream], today: date) -> tuple[dict[int, int], float]:
    """Usual net in or out for each day of the week, and its daily spread, for everything that is
    not a known item: (weekday -> pence, spread per day)."""
    start = today - timedelta(weeks=EVERYDAY_WEEKS)
    daily: dict = defaultdict(int)
    for ln in lines:
        if ln.group in ("everyday", "salaries", "rent") and ln.key not in found and start <= ln.record.date < today:
            daily[ln.record.date] += ln.record.amount_minor * (1 if ln.record.direction == "in" else -1)
    days = [start + timedelta(days=i) for i in range((today - start).days)]
    if not days:
        return {}, 0.0
    by_wd: dict = defaultdict(list)
    for d in days:
        by_wd[d.weekday()].append(daily.get(d, 0))
    return ({wd: round(statistics.fmean(v)) for wd, v in by_wd.items()},  # whole pence, so sums are exact
            statistics.pstdev([daily.get(d, 0) for d in days]))


# ── VAT ────────────────────────────────────────────────────────────────────


def _vat_item(db: Session, lines: list[ledger.Line], found: dict[str, Stream], today: date, end: date) -> Item | None:
    """The next VAT payment, estimated from the VAT on invoices and bills of that quarter,
    unless the bank already shows a regular VAT payment (then it is a repeating item)."""
    biz = ledger.business(db)
    if biz.country != "GB" or any(s.group == "tax" for s in found.values()):
        return None
    rate = ledger.tax_rate(db)
    if not rate:
        return None
    paid = [ln.record for ln in lines if ln.group == "tax" and ln.record.direction == "out"]
    if paid:  # the next one is three months after the last
        due = paid[-1].date
        while due <= today:
            due = add_months(due, 3, 7)
    else:  # calendar quarters: due one month and seven days after the quarter ends
        due, m = None, date(today.year - 1, 12, 1)
        while not due:
            if m.month in (3, 6, 9, 12) and add_months(m, 2, 7) > today:
                due = add_months(m, 2, 7)  # quarter to 30 September -> 7 November
            m = add_months(m, 1)
    if not due or due > end:
        return None
    q_end = add_months(due.replace(day=1), -2)
    q_end = q_end.replace(day=calendar.monthrange(q_end.year, q_end.month)[1])
    q_start = add_months(q_end.replace(day=1), -2)
    rows = db.execute(select(Record).where(Record.kind.in_(("invoice", "bill")), Record.status != "void",
                                           Record.currency == biz.currency, Record.date >= q_start,
                                           Record.date <= q_end)).scalars().all()
    out_tax = sum(r.tax_minor or 0 for r in rows if r.kind == "invoice")
    in_tax = sum(r.tax_minor or 0 for r in rows if r.kind == "bill")
    card = sum(ln.record.amount_minor for ln in lines if ln.group == "payout" and q_start <= ln.record.date <= q_end)
    card_tax = round(card * rate / (1 + rate))
    elapsed = (min(today, q_end) - q_start).days + 1
    scale = ((q_end - q_start).days + 1) / elapsed if elapsed > 0 else 1
    amount = round((out_tax + card_tax - in_tax) * scale)
    if amount <= 0:
        return None
    return Item(f"vat:{due.isoformat()}", "VAT (estimated)", "tax", -amount, due, due, due,
                why=f"VAT for {q_start:%-d %b} to {q_end:%-d %b}: {_money(out_tax + card_tax)} charged on sales "
                    f"(including card sales) less {_money(in_tax)} paid on bills"
                    + (", scaled up because the quarter isn't over" if scale > 1 else ""))


# ── Planned costs (what-if) ────────────────────────────────────────────────


def _planned(rows: list[dict], today: date, end: date) -> list[Item]:
    items = []
    for i, p in enumerate(rows):
        sign = 1 if p.get("direction") == "in" else -1
        d, n = p["date"], 0
        while d <= end:
            if d > today:
                items.append(Item(f"planned:{p.get('id') or i}:{d.isoformat()}", p["label"], "planned",
                                  sign * abs(int(p["amount_minor"])), d, d, d, movable=False,
                                  why="A planned cost you added" if sign < 0 else "Planned money in you added"))
            n += 1
            if p.get("repeat") == "weekly":
                d = p["date"] + timedelta(weeks=n)
            elif p.get("repeat") == "monthly":
                d = add_months(p["date"], n)
            else:
                break
    return items


def saved_plans(db: Session) -> list[dict]:
    return [{"id": str(p.id), "label": p.name, "amount_minor": p.amount_minor, "date": p.date,
             "repeat": p.repeat, "direction": p.direction}
            for p in db.execute(select(PlannedItem).where(PlannedItem.active.is_(True))).scalars()]


# ── The forecast ───────────────────────────────────────────────────────────


def safety_level(db: Session, lines: list[ledger.Line], today: date) -> tuple[int, str]:
    biz = ledger.business(db)
    if biz.safety_level_minor is not None:
        return biz.safety_level_minor, "Set by you"
    start = today - timedelta(days=90)
    spent = sum(ln.record.amount_minor for ln in lines if ln.record.direction == "out" and ln.record.date >= start
                and ln.group != "transfer")
    level = round(spent / 90 * SAFETY_DAYS / 10_000) * 10_000  # to the nearest £100
    return level, f"Two weeks of your usual spending ({_money(spent)} went out in the last 90 days)"


def build(db: Session, today: date | None = None, planned: list[dict] | None = None,
          excluded: set | None = None, moved: dict | None = None) -> dict:
    """The forecast. planned/excluded/moved make a what-if copy; real records never change."""
    today = today or date.today()
    end = today + timedelta(days=HORIZON)
    names, terms = ledger.names(db), ledger.terms(db)
    position = ledger.cash(db)
    lines = ledger.bank_lines(db, since=today - timedelta(days=HISTORY_DAYS), until=today)
    late = lateness(db, today)

    items = _invoice_items(db, today, late, names, terms) + _bill_items(db, today, names, terms)
    found = streams(lines, today, names)
    regular = book_streams(db, today, names)
    items += _stream_items({**found, **regular}, today, end, late, position["platform_minor"])
    vat = _vat_item(db, lines, found, today, end)
    if vat:
        items.append(vat)
    plans = saved_plans(db) + list(planned or [])
    items += _planned(plans, today, end)

    excluded = excluded or set()
    items = [it for it in items if it.id not in excluded]
    for it in items:
        if moved and it.id in moved and it.movable:
            it.expected = it.best = it.worst = max(moved[it.id], today + timedelta(days=1))
    items = [it for it in items if any(d and d <= end for d in (it.expected, it.best, it.worst))]

    pattern, sigma_day = everyday(lines, found, today)
    var_day = sigma_day ** 2 + sum(s.spread ** 2 / PERIODS[s.period][0] for s in [*found.values(), *regular.values()])
    series = []
    totals = {"expected": position["balance_minor"], "best": position["balance_minor"],
              "worst": position["balance_minor"]}
    by_day: dict = defaultdict(lambda: defaultdict(int))
    for it in items:
        for case in totals:
            d = it.on(case)
            if d and d <= end:
                by_day[case][d] += it.amount
    for i in range(HORIZON + 1):
        d = today + timedelta(days=i)
        if i:
            usual = pattern.get(d.weekday(), 0)
            for case in totals:
                totals[case] += by_day[case].get(d, 0) + usual
        band = Z * math.sqrt(var_day * i)
        series.append({"date": d.isoformat(), "expected_minor": round(totals["expected"]),
                       "best_minor": round(totals["best"] + band), "worst_minor": round(totals["worst"] - band)})

    safety, safety_why = safety_level(db, lines, today)
    low = min(series, key=lambda p: p["expected_minor"])
    worst_low = min(series, key=lambda p: p["worst_minor"])
    _, foreign_inv = ledger.open_items(db, "invoice")
    _, foreign_bills = ledger.open_items(db, "bill")
    return {
        "today": today.isoformat(),
        "currency": position["currency"],
        "balance_minor": position["balance_minor"],
        "safety_level_minor": safety,
        "safety_level_why": safety_why,
        "lowest": {"balance_minor": low["expected_minor"], "date": low["date"]},
        "worst_lowest": {"balance_minor": worst_low["worst_minor"], "date": worst_low["date"]},
        "horizons": {str(n): series[n]["expected_minor"] for n in (7, 30, 60, 90)},
        "series": series,
        "bills": [{"id": it.id, "date": it.expected.isoformat(), "label": it.label, "amount_minor": -it.amount,
                   "movable": it.movable} for it in sorted(items, key=lambda it: it.expected or end)
                  if it.amount < 0 and it.expected],
        "items": [{"id": it.id, "label": it.label, "kind": it.kind, "amount_minor": it.amount,
                   "expected": it.expected.isoformat() if it.expected else None,
                   "best": it.best.isoformat() if it.best else None,
                   "worst": it.worst.isoformat() if it.worst else None, "why": it.why, "record_ids": it.record_ids}
                  for it in sorted(items, key=lambda it: it.expected or it.best or end)],
        "repeating": [{"label": s.label, "every": s.period, "amount_minor": s.amount, "last": s.last.isoformat(),
                       "times": s.count} for s in sorted([*found.values(), *regular.values()],
                                                         key=lambda s: -abs(s.amount))],
        "everyday_minor_per_week": round(sum(pattern.values())),
        "warnings": warnings(series, items, safety),
        "left_out": [{"label": f"{len(foreign_inv)} unpaid invoice(s) in other currencies", "count": len(foreign_inv)}]
        * bool(foreign_inv) + [{"label": f"{len(foreign_bills)} unpaid bill(s) in other currencies",
                                "count": len(foreign_bills)}] * bool(foreign_bills)
        + [{"label": f"{a['name']} ({a['currency']})", "count": 1} for a in position["left_out"]],
    }


def warnings(series: list[dict], items: list[Item], safety: int) -> list[dict]:
    """The first day cash drops below the safety level, and what causes it (section 5).
    Graded watch (worst case only), warning (expected case) and urgent (within 7 days);
    `severity` is the same in the app's three-step scale."""
    today = date.fromisoformat(series[0]["date"])

    def first_below(field_: str, level: int) -> dict | None:
        return next((p for p in series[1:] if p[field_] < level), None)

    def causes(on: date, case: str) -> list[Item]:
        week = [it for it in items if it.amount < 0 and (d := it.on(case)) and on - timedelta(days=7) < d <= on]
        return sorted(week, key=lambda it: it.amount)[:3]

    out = []
    for level, what in ((0, "below zero"), (safety, "below your safety level")):
        if level == 0 and not first_below("expected_minor", 0):
            continue
        hit = first_below("expected_minor", level)
        if hit:
            on = date.fromisoformat(hit["date"])
            days = (on - today).days
            top = causes(on, "expected")
            lead = f"{top[0].label} on {_day(top[0].expected)}" if top else f"Spending in the week to {_day(on)}"
            out.append({
                "id": f"cash-{'zero' if level == 0 else 'safety'}-{hit['date']}",
                "grade": "urgent" if days <= 7 else "warning", "severity": "urgent" if days <= 7 else "attention",
                "sentence": f"{lead} will take you {what}" + (f" in {days} days." if days > 1 else " tomorrow."),
                "why": f"We expect {_money(hit['expected_minor'])}{' overdrawn' if hit['expected_minor'] < 0 else ''} "
                       f"on {_day(on)}, against a safety level of {_money(safety)}."
                       + (" Biggest payments in the week before: " + ", ".join(
                           f"{it.label} {_money(it.amount)} ({_day(it.expected)})" for it in top) + "." if top else ""),
                "date": hit["date"], "days": days, "balance_minor": hit["expected_minor"],
                "item_ids": [it.id for it in top],
            })
            if level == 0:
                return out  # below zero says it all
        elif level == safety:
            worst = first_below("worst_minor", level)
            if worst:
                on = date.fromisoformat(worst["date"])
                out.append({
                    "id": f"cash-watch-{worst['date']}", "grade": "watch", "severity": "info",
                    "sentence": f"If customers pay late, cash could fall below your safety level around {_day(on)}.",
                    "why": f"In the worst case we expect {_money(worst['worst_minor'])} on {_day(on)}, against a "
                           f"safety level of {_money(safety)}. The expected case stays above it.",
                    "date": worst["date"], "days": (on - today).days, "balance_minor": worst["worst_minor"],
                    "item_ids": [it.id for it in causes(on, "worst")],
                })
    return out


def what_if(db: Session, planned: list[dict], excluded: list[str], moved: dict, today: date | None = None) -> dict:
    """The forecast with planned costs added, bills left out or moved (section 8). Real records are not changed."""
    base = build(db, today)
    after = build(db, today, planned=planned, excluded=set(excluded), moved=moved)
    safety = after["safety_level_minor"]
    after["what_if"] = {
        "lowest_before": base["lowest"], "lowest_after": after["lowest"],
        "worst_lowest_after": after["worst_lowest"],
        "below_safety": after["lowest"]["balance_minor"] < safety,
        "worst_below_safety": after["worst_lowest"]["balance_minor"] < safety,
        "shortfall_minor": max(0, safety - after["lowest"]["balance_minor"]),
        "worst_shortfall_minor": max(0, safety - after["worst_lowest"]["balance_minor"]),
    }
    return after
