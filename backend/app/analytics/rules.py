"""The facts behind recommendations, found by fixed rules (docs/ALGORITHMS.md, section 9).

Each rule reads our records and returns findings with the numbers and records behind them.
No AI here: the AI only words a finding afterwards, and its figures are checked against it.

  supplier details changed  address, email, phone or bank details on a bill differ from the
                            supplier's record (bank details: also a fraud warning, never muted)
  price rise                a supplier's latest bills, or a price on one of their lines, are 10%
                            or more above the median of the 3 months before
  slow payer                a customer pays 7+ days after the due date on average over 3+
                            invoices, or lately (invoices of the last 60 days) pays 7+ days late
                            and 3+ days later than before
  spending creep            a spending category rose 3 months in a row (by 10% or more in all),
                            or a new monthly charge appeared
  reliance on one customer  one customer was more than 30% of what was invoiced in 90 days
"""

import itertools
import math
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from uuid import UUID

from rapidfuzz import fuzz
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..copilot.wording import day, money
from ..models import Action, Counterparty, CounterpartyVersion, Document, Record
from ..pipeline import counterparties, extract
from . import forecast, ledger

PRICE_RISE = 0.10
SLOW_DAYS = 7
SLOWER_DAYS = 3
CREEP_RISE = 0.10
CREEP_MIN_MINOR = 10_00  # at least £10 a month more
CONCENTRATION = 0.30
DETAILS_DAYS = 90

FIELD_LABELS = {"bank_account": "bank account", "sort_code": "sort code", "email": "email address",
                "phone": "phone number", "address": "address"}
SEVERITY_ORDER = {"info": 1, "watch": 2, "warning": 3, "urgent": 4}
APP_SEVERITY = {"info": "info", "watch": "info", "warning": "attention", "urgent": "urgent"}


@dataclass
class Finding:
    kind: str
    fingerprint: str
    counterparty_id: object
    severity: str  # info | watch | warning | urgent
    money_at_stake_minor: int
    facts: dict  # what the AI may use, already written as money, percentages and dates
    title: str  # the plain template, used when the AI is paused, unavailable or wrong
    body: str
    why: str  # the rule that raised it
    evidence: list[dict] = field(default_factory=list)
    next_step: dict = field(default_factory=dict)
    mutable: bool = True
    measure: float = 0  # how bad it is, to tell when it gets worse

    @property
    def score(self) -> float:
        return SEVERITY_ORDER[self.severity] * 1e12 + self.money_at_stake_minor


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _norm_address(s: str | None) -> str:
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return " ".join(w for w in s.split() if w not in ("unit", "flat", "suite", "the"))


# ── Supplier details changed ───────────────────────────────────────────────


def _same(field_: str, old: dict, new: dict) -> bool:
    if old.get("fp") == new.get("fp"):
        return True
    # The same address read slightly differently ("4, Mill Lane" and "Unit 4, Mill Lane") is not a change
    return field_ == "address" and fuzz.token_set_ratio(_norm_address(old.get("display")),
                                                        _norm_address(new.get("display"))) >= 90


def _changes(known: dict, details: dict) -> list[dict]:
    out = []
    for f, new in details.items():
        old = known.get(f)
        if old and not _same(f, old, new):
            out.append({"field": f, "before": old.get("display"), "after": new.get("display"),
                        "before_seen": old.get("seen_at"), "fp": new.get("fp")})
    return out


def details_changed(db: Session, today: date) -> list[Finding]:
    names = ledger.names(db)
    since = today - timedelta(days=DETAILS_DAYS)
    by_cp: dict = defaultdict(list)  # counterparty -> [(when, changes, where, amount, action)]
    suppliers = {c.id for c in db.execute(select(Counterparty).where(Counterparty.kind == "supplier")).scalars()}
    for cp in suppliers:
        versions = db.execute(select(CounterpartyVersion).where(CounterpartyVersion.counterparty_id == cp)
                              .order_by(CounterpartyVersion.seen_at)).scalars().all()
        known: dict = {}
        for v in versions:
            found = _changes(known, v.details)
            if found and v.seen_at.date() >= since:
                by_cp[cp].append((v.seen_at.date(), found, "an approved bill", None, None))
            for f, val in v.details.items():
                known[f] = dict(val, seen_at=v.seen_at.isoformat())
    # Bills still waiting for approval: their details are not on record yet
    for a in db.execute(select(Action).where(Action.type == "approve_document", Action.status == "pending")).scalars():
        cp = a.payload.get("counterparty_id")
        details = a.payload.get("details") or {}
        if not cp or not details:
            continue
        cid = UUID(cp)
        if cid not in suppliers:
            continue
        found = _changes(counterparties.latest_details(db, cid), details)
        if found:
            by_cp[cid].append((a.created_at.date(), found, "a bill waiting for approval", a.amount_minor, a))

    out = []
    for cid, seen in by_cp.items():
        name = names.get(cid, "A supplier")
        # One finding per new set of details. Bills sharing the same new bank details (a fraud tried
        # several times) are one finding, whatever else differs on them.
        groups: dict = {}
        for when, found, where, amount, action in seen:
            bank_part = sorted((c["field"], c["fp"]) for c in found if c["field"] in counterparties.BANK_FIELDS)
            key = tuple(bank_part) or tuple(sorted((c["field"], c["fp"]) for c in found))
            g = groups.setdefault(key, {"when": when, "changes": {}, "where": set(), "amount": 0, "bills": 0,
                                        "actions": [], "bank": bool(bank_part)})
            g["when"] = min(g["when"], when)
            g["where"].add(where)
            for c in found:
                g["changes"].setdefault(c["field"], c)
            if amount:
                g["amount"] += amount
                g["bills"] += 1
            if action:
                g["actions"].append(str(action.id))
        for key, g in groups.items():
            bank = g["bank"]
            changes = sorted(g["changes"].values(), key=lambda c: (c["field"] not in counterparties.BANK_FIELDS,
                                                                   c["field"]))
            fields_txt = _and([FIELD_LABELS[c["field"]] for c in changes])
            where = " and ".join(sorted(g["where"]))
            facts = {"supplier": name, "changed": fields_txt, "first seen on": day(g["when"]), "seen on": where,
                     "changes": [{"detail": FIELD_LABELS[c["field"]], "before": c["before"], "now": c["after"]}
                                 for c in changes]}
            if g["amount"]:
                facts["bills waiting with these details"] = g["bills"]
                facts["waiting to be paid"] = money(g["amount"])
            what = "bank details" if bank else fields_txt
            body = (f"The {fields_txt} on {where} from {name} differ from the ones on record. "
                    + ("Confirm with the supplier using the contact details already on record before paying."
                       if bank else "Check the change with the supplier before updating their record."))
            out.append(Finding(
                kind="bank_details_changed" if bank else "supplier_details_changed",
                fingerprint=f"{'bank' if bank else 'details'}:{cid}:" + ",".join(f"{f}={fp[:16]}" for f, fp in key),
                counterparty_id=cid, severity="urgent" if bank else "warning",
                money_at_stake_minor=g["amount"], facts=facts,
                title=f"{name}'s {what} changed on {day(g['when'])}", body=body,
                why="We compare the details on every bill with the supplier's record. A change of bank details "
                    "is a common fraud, so it always needs checking.",
                evidence=[{"label": FIELD_LABELS[c["field"]].capitalize(), "before": c["before"] or "",
                           "after": c["after"] or ""} for c in changes],
                next_step={"label": f"Ask {name} to confirm, using the email on record", "action": "email_supplier",
                           "purpose": f"ask them to confirm whether their {what} really changed",
                           "contact_before": min((c["before_seen"] for c in changes if c["before_seen"]), default=None),
                           "related_actions": g["actions"]},
                mutable=not bank, measure=g["amount"],
            ))
    return out


# ── Supplier price rise ────────────────────────────────────────────────────


def _bills(db: Session, since: date) -> dict:
    biz = ledger.business(db)
    rows = db.execute(select(Record).where(Record.kind == "bill", Record.status != "void",
                                           Record.currency == biz.currency, Record.date >= since,
                                           Record.counterparty_id.is_not(None)).order_by(Record.date)).scalars()
    out: dict = defaultdict(list)
    for r in rows:
        out[r.counterparty_id].append(r)
    return out


def _creeping(amounts: list[int]) -> bool:
    """Rising step by step (a creeping charge), rather than one jump."""
    return len(amounts) >= 3 and all(b >= a for a, b in itertools.pairwise(amounts)) \
        and sum(b > a for a, b in itertools.pairwise(amounts)) >= 2


def _norm_line(s: str | None) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split())


def _units(db: Session, r: Record) -> dict[str, tuple[int, int]]:
    """(price per unit, line amount) on a bill, where we know the unit price: from its lines, or from
    the document we read it from."""
    out = {}
    for ln in r.lines or []:
        if ln.get("unit_price_minor"):
            out[_norm_line(ln.get("description"))] = (int(ln["unit_price_minor"]), int(ln.get("amount_minor") or 0))
    if not out and r.document_id:
        doc = db.get(Document, r.document_id)
        for li in ((doc.fields or {}).get("line_items") or []) if doc else []:
            unit = extract.to_minor(li.get("unit_price"))
            if unit:
                out[_norm_line(li.get("description"))] = (unit, extract.to_minor(li.get("amount")) or 0)
    return out


def _usual_unit(amounts: list[int]) -> int | None:
    """A line's price per unit from past amounts alone: lines of 7, 8 and 9 bags at £45.00 are
    £315, £360 and £405, all multiples of £45.00. The largest price that at least three, and three
    quarters, of the different past amounts are whole multiples of (so one bill at a new price
    doesn't hide the usual one)."""
    distinct = sorted({a for a in amounts if a > 0})
    if len(distinct) < 3:
        return None
    best = None
    for a, b in itertools.combinations(distinct, 2):
        u = math.gcd(a, b)
        if u < 50 or distinct[-1] / u > 60 or (best and u <= best):
            continue
        fits = sum(1 for x in distinct if x % u == 0)
        if fits >= 3 and fits >= 0.75 * len(distinct):
            best = u
    return best


def _line_rises(db: Session, latest: Record, before: list[Record]) -> list[dict]:
    """Prices per unit on the latest bill against the same line on earlier bills."""
    now = _units(db, latest)
    if not now:
        return []
    known: dict = defaultdict(list)
    amounts: dict = defaultdict(list)
    for r in before:
        for k, (v, _) in _units(db, r).items():
            known[k].append(v)
        for ln in r.lines or []:
            if ln.get("amount_minor"):
                amounts[_norm_line(ln.get("description"))].append(int(ln["amount_minor"]))
    out = []
    for line, (unit, amount) in now.items():
        usual = statistics.median(known[line]) if len(known[line]) >= 2 else _usual_unit(amounts[line])
        if usual and unit >= usual * (1 + PRICE_RISE):
            label = next((ln.get("description") for ln in (latest.lines or [])
                          if _norm_line(ln.get("description")) == line), None) or line
            out.append({"line": label[:1].upper() + label[1:], "usual": int(usual), "now": int(unit),
                        "rise": unit / usual - 1, "extra": round(amount * (1 - usual / unit))})
    return out


def price_rises(db: Session, today: date) -> list[Finding]:
    names = ledger.names(db)
    out = []
    for cid, bills in _bills(db, today - timedelta(days=200)).items():
        recent = [b for b in bills if b.date >= today - timedelta(days=45)]
        if not recent:
            continue
        latest = recent[-1]
        # The latest two bills (or the latest, for a monthly supplier) against the 3 months before them
        run = recent[-2:] if len(recent) >= 2 and (recent[-1].date - recent[-2].date).days <= 21 else recent[-1:]
        start = run[0].date
        base = [b for b in bills if start - timedelta(days=91) <= b.date < start]
        lines, line_bill = [], None
        for b in reversed(recent):  # the newest recent bill whose prices per unit rose
            lines = _line_rises(db, b, [x for x in bills if b.date - timedelta(days=91) <= x.date < b.date])
            if lines:
                line_bill = b
                break
        bill_rise = None
        if len(base) >= 3 and not _creeping([b.amount_minor for b in base]):
            usual = statistics.median(b.amount_minor for b in base)
            if usual > 0 and all(b.amount_minor >= usual * (1 + PRICE_RISE) for b in run):
                now = round(statistics.fmean(b.amount_minor for b in run))
                bill_rise = (int(usual), now, now / usual - 1)
        if not bill_rise and not lines:
            continue
        name = names.get(cid, "A supplier")
        per_year = len([b for b in bills if b.date >= today - timedelta(days=182)]) * 2
        if bill_rise:
            usual, now, rise = bill_rise
            extra = (now - usual) * per_year
        else:
            latest = line_bill
            top = max(lines, key=lambda x: x["rise"])
            usual, now, rise = top["usual"], top["now"], top["rise"]
            extra = sum(x["extra"] for x in lines) * per_year
        facts = {"supplier": name, "latest bill": f"{latest.reference or ''} on {day(latest.date)}".strip(),
                 "latest bill amount": money(latest.amount_minor)}
        if bill_rise:
            facts |= {"usual bill (median of the 3 months before)": money(usual),
                      "bills compared": len(base), "recent bills": len(run),
                      "recent average": money(now), "rise": _pct(rise)}
            if extra > 0:
                facts["about this much more a year at this rate"] = money(extra)
        if lines:
            facts["price changes on lines"] = [{"line": x["line"], "usual price": money(x["usual"]),
                                                "now": money(x["now"]), "rise": _pct(x["rise"])} for x in lines]
            if not bill_rise and extra > 0:
                facts["about this much more a year at this rate"] = money(extra)
        if bill_rise:
            body = (f"{name}'s recent bills average {money(now)}, {_pct(rise)} more than its usual {money(usual)}."
                    + (f" At this rate that is about {money(extra)} more a year." if extra > 0 else ""))
            if lines:
                x = max(lines, key=lambda x: x["rise"])
                body += f" {x['line']} went from {money(x['usual'])} to {money(x['now'])} ({_pct(x['rise'])})."
        else:
            x = max(lines, key=lambda x: x["rise"])
            body = (f"On {name}'s bill {latest.reference or ''} of {day(latest.date)}, {x['line']} costs "
                    f"{money(x['now'])}, up {_pct(x['rise'])} from {money(x['usual'])}."
                    + (f" At this rate that is about {money(extra)} more a year." if extra > 0 else ""))
        body += " Ask them about the increase, or compare prices with other suppliers."
        evidence = [{"label": "Usual bill", "before": money(usual), "after": money(now)}] if bill_rise else []
        evidence += [{"label": x["line"] or "Line", "before": money(x["usual"]), "after": money(x["now"])} for x in lines]
        evidence.append({"label": "Latest bill", "before": "", "after": money(latest.amount_minor),
                         "record_id": str(latest.id)})
        out.append(Finding(
            kind="price_rise", fingerprint=f"price:{cid}", counterparty_id=cid,
            severity="warning" if rise >= 0.2 or extra >= 1_000_00 else "watch",
            money_at_stake_minor=max(extra, 0), facts=facts,
            title=f"{name} is charging {_pct(rise)} more" if bill_rise else
            f"{name} put the price of {max(lines, key=lambda x: x['rise'])['line']} up {_pct(rise)}", body=body,
            why="We compare each supplier's latest bills, and the prices on their lines, with the median of the "
                "3 months before. We flag a rise of 10% or more.",
            evidence=evidence,
            next_step={"label": f"Draft an email to {name} about the increase", "action": "email_supplier",
                       "purpose": "politely ask why the price went up and whether the old price is still possible"},
            measure=rise,
        ))
    return out


# ── Slow-paying customer ───────────────────────────────────────────────────


def slow_payers(db: Session, today: date) -> list[Finding]:
    names, terms = ledger.names(db), ledger.terms(db)
    biz = ledger.business(db)
    rows = db.execute(select(Record).where(Record.kind == "invoice", Record.status == "paid",
                                           Record.paid_date.is_not(None), Record.counterparty_id.is_not(None),
                                           Record.date >= today - timedelta(days=365))).scalars().all()
    late: dict = defaultdict(list)
    for r in rows:
        late[r.counterparty_id].append((r.date, (r.paid_date - ledger.due(r, terms)).days))
    invoices, _ = ledger.open_items(db, "invoice")
    out = []
    for cid, seen in late.items():
        if len(seen) < 3:
            continue
        mean = statistics.fmean(d for _, d in seen)
        cut = today - timedelta(days=60)  # invoices issued in the last 60 days against those before
        recent = [d for issued, d in seen if issued >= cut]
        earlier = [d for issued, d in seen if issued < cut]
        slower = (len(recent) >= 2 and len(earlier) >= 3 and statistics.fmean(recent) >= SLOW_DAYS
                  and statistics.fmean(recent) - statistics.fmean(earlier) >= SLOWER_DAYS)
        if mean < SLOW_DAYS and not slower:
            continue
        name = names.get(cid, "A customer")
        mine = [r for r in invoices if r.counterparty_id == cid and r.currency == biz.currency]
        overdue = [r for r in mine if ledger.due(r, terms) < today]
        owed = sum(r.open_minor for r in mine)
        overdue_minor = sum(r.open_minor for r in overdue)
        facts = {"customer": name, "invoices paid in the last year": len(seen),
                 "average days paid after the due date": f"{mean:.0f}",
                 "payment terms": f"{terms.get(cid) or 30} days"}
        if slower:
            facts |= {"average days late on earlier invoices": f"{statistics.fmean(earlier):.0f}",
                      "average days late on invoices of the last 60 days": f"{statistics.fmean(recent):.0f}"}
        if owed:
            facts["they owe now"] = money(owed)
        if overdue_minor:
            facts["of which overdue"] = money(overdue_minor)
            facts["overdue invoices"] = ", ".join(r.reference or "" for r in overdue[:5]).strip(", ")
        lead = (f"{name} pays on average {mean:.0f} days after the due date"
                + (f", and lately {statistics.fmean(recent):.0f} days" if slower else "") + ".")
        tip = (" Consider asking for a deposit or payment upfront, shorter payment terms, an early-payment "
               "discount, or a reminder before the due date.")
        out.append(Finding(
            kind="slow_payer", fingerprint=f"slow:{cid}", counterparty_id=cid,
            severity="warning" if overdue_minor and mean >= 10 else "watch",
            money_at_stake_minor=owed, facts=facts,
            title=f"{name} pays late" + (" and is getting slower" if slower else ""),
            body=lead + (f" They owe {money(owed)} now, {money(overdue_minor)} of it overdue." if overdue_minor else
                         f" They owe {money(owed)} now." if owed else "") + tip,
            why="We look at every paid invoice in the last year. We flag a customer who pays 7 or more days after "
                "the due date on average over at least 3 invoices, or whose recent invoices are paid 7 or more "
                "days late and 3 or more days later than before.",
            evidence=[{"label": "Average days late", "before": f"{statistics.fmean(earlier):.0f}" if slower else "",
                       "after": f"{statistics.fmean(recent) if slower else mean:.0f}"}]
            + [{"label": f"Invoice {r.reference or ''}".strip(), "before": f"due {day(ledger.due(r, terms))}",
                "after": money(r.open_minor), "record_id": str(r.id)} for r in overdue[:5]],
            next_step=({"label": f"Draft a payment reminder to {name}", "action": "send_payment_reminder",
                        "purpose": "a friendly reminder about the overdue invoices, asking when they will be paid",
                        "record_ids": [str(r.id) for r in overdue[:5]]} if overdue else
                       {"label": "Consider shorter payment terms or a deposit", "action": None,
                        "href": "/health"}),
            measure=mean if not slower else statistics.fmean(recent),
        ))
    return out


# ── Spending creep ─────────────────────────────────────────────────────────


def spending_creep(db: Session, today: date, skip: set) -> list[Finding]:
    biz = ledger.business(db)
    names = ledger.names(db)
    this_month = today.replace(day=1)
    months = [forecast.add_months(this_month, -i) for i in (4, 3, 2, 1)]  # the last four full months
    rows = db.execute(select(Record).where(Record.kind.in_(("bill", "payment_out")), Record.status != "void",
                                           Record.source != "plaid", Record.currency == biz.currency,
                                           Record.date >= months[0], Record.date < this_month)).scalars().all()
    by_cat: dict = defaultdict(lambda: defaultdict(int))
    by_party: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    for r in rows:
        if r.kind == "payment_out" and (r.external.get("linked") or r.external.get("qbo_type") == "BillPayment"):
            continue  # paying a bill, already counted as the bill
        cat = (r.category or "").strip().lower()
        if not cat or cat in ("other", "sales", "transfer", "tax", "loan repayments"):
            continue
        m = r.date.replace(day=1)
        by_cat[cat][m] += ledger.net(r)
        by_party[cat][r.counterparty_id][m] += ledger.net(r)
    out = []
    for cat, per_month in by_cat.items():
        series = [per_month.get(m, 0) for m in months]
        if not all(b > a for a, b in itertools.pairwise(series)) or series[0] <= 0:
            continue
        rise = series[-1] / series[0] - 1
        if rise < CREEP_RISE or series[-1] - series[0] < CREEP_MIN_MINOR:
            continue
        drivers = sorted(by_party[cat].items(), key=lambda kv: -(kv[1].get(months[-1], 0) - kv[1].get(months[0], 0)))
        main = drivers[0][0] if drivers else None
        if main in skip:
            continue  # already raised as that supplier's price rise
        main_name = names.get(main)
        label = cat[:1].upper() + cat[1:]
        facts = {"category": label, "months compared": ", ".join(f"{m:%B %Y}" for m in months),
                 "spent each month (before VAT)": ", ".join(money(x) for x in series),
                 "rise over 3 months": _pct(rise),
                 "about this much more a year at the latest rate": money((series[-1] - series[0]) * 12)}
        if main_name:
            facts["mostly from"] = main_name
        out.append(Finding(
            kind="spending_creep", fingerprint=f"creep:{cat}", counterparty_id=main, severity="watch",
            money_at_stake_minor=(series[-1] - series[0]) * 12, facts=facts,
            title=f"{label} costs have risen 3 months in a row",
            body=f"{label} went from {money(series[0])} in {months[0]:%B} to {money(series[-1])} in {months[-1]:%B}, "
                 f"up {_pct(rise)}" + (f", mostly from {main_name}" if main_name else "") + ". Worth reviewing.",
            why="We add up each spending category by month. We flag one that rose in each of the last 3 full "
                "months, by 10% or more in all.",
            evidence=[{"label": f"{m:%B %Y}", "before": "", "after": money(x)} for m, x in zip(months, series, strict=True)],
            next_step={"label": "Review this cost", "action": None, "href": "/health"},
            measure=rise,
        ))
    # A new monthly charge: a supplier first billed in the last 100 days, about a month apart each time
    first_seen = dict(db.execute(select(Record.counterparty_id, Record.date).where(
        Record.kind == "bill", Record.status != "void", Record.counterparty_id.is_not(None))
        .order_by(Record.date.desc())).all())  # ends with each supplier's earliest bill
    for cid, bills in _bills(db, today - timedelta(days=100)).items():
        if cid in skip or first_seen.get(cid) and first_seen[cid] < today - timedelta(days=100) or len(bills) < 2:
            continue
        gaps = [(b.date - a.date).days for a, b in itertools.pairwise(bills)]
        if not all(25 <= g <= 35 for g in gaps):
            continue
        name = names.get(cid, "A supplier")
        each = bills[-1].amount_minor
        out.append(Finding(
            kind="spending_creep", fingerprint=f"new_charge:{cid}", counterparty_id=cid, severity="watch",
            money_at_stake_minor=each * 12,
            facts={"supplier": name, "first bill": day(bills[0].date), "bills so far": len(bills),
                   "latest bill amount": money(each), "about this much a year": money(each * 12)},
            title=f"A new monthly charge from {name}",
            body=f"{name} has billed you every month since {day(bills[0].date)}, {money(each)} last time "
                 f"(about {money(each * 12)} a year). Check you still need it.",
            why="We flag a supplier first billed in the last 100 days who bills about once a month.",
            evidence=[{"label": f"Bill {b.reference or ''}".strip(), "before": day(b.date), "after": money(b.amount_minor),
                       "record_id": str(b.id)} for b in bills[-3:]],
            next_step={"label": "Review this cost", "action": None, "href": "/health"},
            measure=each,
        ))
    return out


# ── Reliance on one customer ───────────────────────────────────────────────


def concentration(db: Session, today: date) -> list[Finding]:
    biz = ledger.business(db)
    names = ledger.names(db)
    rows = db.execute(select(Record.counterparty_id, Record.amount_minor).where(
        Record.kind == "invoice", Record.status != "void", Record.currency == biz.currency,
        Record.date > today - timedelta(days=90), Record.date <= today)).all()
    by: dict = defaultdict(int)
    for cid, amount in rows:
        by[cid] += amount
    total = sum(by.values())
    if total <= 0 or len(by) < 2:
        return []
    out = []
    for cid, amount in by.items():
        share = amount / total
        if cid is None or share <= CONCENTRATION:
            continue
        name = names.get(cid, "One customer")
        out.append(Finding(
            kind="customer_concentration", fingerprint=f"concentration:{cid}", counterparty_id=cid, severity="info",
            money_at_stake_minor=amount,
            facts={"customer": name, "their invoices in the last 90 days": money(amount),
                   "all invoices in the last 90 days": money(total), "their share": _pct(share),
                   "customers invoiced": len(by)},
            title=f"{name} is {_pct(share)} of what you invoice",
            body=f"{name} brought in {money(amount)} of the {money(total)} you invoiced in the last 90 days "
                 f"({_pct(share)}). Losing them, or a late payment from them, would hit cash hard.",
            why="We flag any customer who was more than 30% of what you invoiced in the last 90 days.",
            evidence=[{"label": "Share of invoiced sales", "before": "", "after": _pct(share)}],
            next_step={"label": "For information", "action": None, "href": "/health"},
            measure=share,
        ))
    return out


def find_all(db: Session, today: date | None = None) -> list[Finding]:
    """Every finding, most important first."""
    today = today or date.today()
    found = details_changed(db, today) + price_rises(db, today) + slow_payers(db, today)
    found += spending_creep(db, today, skip={f.counterparty_id for f in found if f.kind == "price_rise"})
    found += concentration(db, today)
    return sorted(found, key=lambda f: -f.score)
