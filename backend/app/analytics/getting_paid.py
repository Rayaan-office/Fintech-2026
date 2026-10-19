"""Getting paid faster and for less (docs/ALGORITHMS.md, "Getting paid"). Fixed rules, no AI.

  payment costs   over 180 days, a customer's payments arrived £10 or more short over 2 or more
                  payments (bank charges taken on the way), or the way they pay takes 5 or more
                  days longer than card
  chase overdue   a customer has overdue invoices due a reminder: 1 (friendly) once overdue,
                  2 (firm) 7 days after the first, 3 (final notice) 14 days after the second;
                  a business owner approves a final notice

The card fee is this business's own (its card fees over its card payments in the same 180 days);
with too few card payments of its own we use a stated typical rate instead.
"""

import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..connectors import payment_links
from ..copilot.wording import day, money
from ..models import Match, Record, Reminder
from . import ledger, methods
from .rules import Finding

LOOKBACK_DAYS = 180
SHORT_MIN_MINOR = 10_00
SHORT_MIN_PAYMENTS = 2
SLOWER_DAYS = 5
OWN_RATE_MIN_PAYMENTS = 3  # card payments of its own before we use the business's own card fees
CARD_DAYS_MIN = 3  # card payments across the business before we compare days to pay with card
# Typical card rates (an assumption, stated wherever it is used): a UK card, and a card from abroad
TYPICAL_CARD = (0.015, 20)  # 1.5% + 20p
TYPICAL_CARD_ABROAD = (0.0325, 20)  # 3.25% + 20p
TRANSFERS = ("bank_transfer", "international_transfer")

STAGES = {1: "friendly", 2: "firm", 3: "final notice"}
STAGE_AFTER = {1: 0, 2: 7, 3: 14}  # days after the due date (stage 1) or after the previous reminder
LAST_STAGE = 3


@dataclass
class Paid:
    invoice: Record
    payment: Record | None
    method: str
    on: date
    due_minor: int  # what the payment was meant to settle (what arrived plus what arrived short)
    short_minor: int

    @property
    def days(self) -> int:
        return (self.on - self.invoice.date).days


def _paid(db: Session, today: date) -> list[Paid]:
    """Every invoice payment in the last 180 days, with how it was paid."""
    cur = ledger.business(db).currency
    since = today - timedelta(days=LOOKBACK_DAYS)
    out, seen = [], set()
    rows = db.execute(select(Match, Record).join(Record, Record.id == Match.right_id)
                      .where(Match.status == "accepted", Record.date >= since, Record.date <= today)).all()
    invoices = {r.id: r for r in db.execute(select(Record).where(
        Record.id.in_({m.left_id for m, _ in rows}), Record.kind == "invoice", Record.status != "void")).scalars()}
    for m, p in rows:
        inv = invoices.get(m.left_id)
        if not inv or inv.currency != cur:
            continue
        short = int((m.signals or {}).get("short_minor") or 0)
        arrived = m.amount_minor or p.amount_minor  # "already settled" links carry no amount
        out.append(Paid(inv, p, methods.of(p, cur), p.date, arrived + short, short))
        seen.add(inv.id)
    # Invoices the payment platform settled itself (paid by card through its own invoice page)
    charges = {str(p.external.get("invoice")): p for p in db.execute(select(Record).where(
        Record.source == "stripe", Record.kind == "payment_in", Record.status != "void")).scalars()
        if p.external.get("invoice")}
    for inv in db.execute(select(Record).where(Record.source == "stripe", Record.kind == "invoice",
                                               Record.status == "paid", Record.currency == cur)).scalars():
        p = charges.get(str(inv.external.get("stripe_invoice")))
        on = inv.paid_date or (p.date if p else None)
        if inv.id in seen or not on or not since <= on <= today:
            continue
        out.append(Paid(inv, p, methods.of(p, cur) if p else "card", on, inv.amount_minor, 0))
    return out


def card_rate(db: Session, today: date, abroad: bool = False) -> dict:
    """What a card payment costs this business: its own fees when it has enough card payments,
    otherwise a typical rate (stated as an assumption)."""
    since = today - timedelta(days=LOOKBACK_DAYS)
    charges = db.execute(select(Record.id, Record.source_ref, Record.amount_minor).where(
        Record.source == "stripe", Record.kind == "payment_in", Record.status != "void",
        Record.date >= since, Record.date <= today)).all()
    if len(charges) >= OWN_RATE_MIN_PAYMENTS:
        refs = {ref for _, ref, _ in charges}
        fees = sum(f.amount_minor for f in db.execute(select(Record).where(
            Record.source == "stripe", Record.kind == "fee", Record.category == "card_fees",
            Record.date >= since)).scalars() if f.external.get("charge") in refs)
        total = sum(a for *_, a in charges)
        if total > 0 and fees > 0:
            rate = fees / total
            return {"rate": round(rate, 4), "fixed_minor": 0, "source": "yours",
                    "label": f"{rate * 100:.1f}%", "payments": len(charges)}
    rate, fixed = TYPICAL_CARD_ABROAD if abroad else TYPICAL_CARD
    return {"rate": rate, "fixed_minor": fixed, "source": "typical", "payments": len(charges),
            "label": f"{rate * 100:g}% + {fixed}p" + (" (a typical rate for a card from abroad)" if abroad
                                                     else " (a typical rate for a UK card)")}


def card_fee(rate: dict, amounts: list[int]) -> int:
    return sum(round(a * rate["rate"]) + rate["fixed_minor"] for a in amounts)


def _by_method(rows: list[Paid]) -> dict:
    out: dict = defaultdict(list)
    for x in rows:
        out[x.method].append(x)
    return out


def method_table(db: Session, rows: list[Paid], today: date) -> list[dict]:
    """Per way of paying: payments, amount, what arrived short, what card would have cost (or did
    cost, for card), and the average days from invoice to payment."""
    out = []
    for method, xs in sorted(_by_method(rows).items(), key=lambda kv: -len(kv[1])):
        rate = card_rate(db, today, abroad=method == "international_transfer")
        out.append({"method": method, "label": methods.LABELS[method], "payments": len(xs),
                    "amount_minor": sum(x.due_minor for x in xs), "short_minor": sum(x.short_minor for x in xs),
                    "short_payments": sum(1 for x in xs if x.short_minor),
                    "card_fee_minor": card_fee(rate, [x.due_minor for x in xs]),
                    "card_fee_is_estimate": method != "card" or rate["source"] != "yours",
                    "days_to_pay": round(statistics.fmean(x.days for x in xs), 1)})
    return out


def _card_days(rows: list[Paid]) -> float | None:
    card = [x.days for x in rows if x.method == "card"]
    return statistics.fmean(card) if len(card) >= CARD_DAYS_MIN else None


# ── Payment costs ──────────────────────────────────────────────────────────


def payment_costs(db: Session, today: date) -> list[Finding]:
    names = ledger.names(db)
    rows = _paid(db, today)
    card_days = _card_days(rows)
    short_open = defaultdict(list)
    for x in ledger.short_paid(db).values():
        if x.record.status == "open" and x.record.open_minor > 0 and x.record.counterparty_id:
            short_open[x.record.counterparty_id].append(x.record)
    per: dict = defaultdict(list)
    for x in rows:
        if x.invoice.counterparty_id:
            per[x.invoice.counterparty_id].append(x)
    out = []
    for cid, mine in per.items():
        by = _by_method(mine)
        others = {m: xs for m, xs in by.items() if m != "card"}
        if not others:
            continue
        main = max(others, key=lambda m: len(others[m]))
        xs = others[main]
        short = [x for x in mine if x.short_minor]
        short_total = sum(x.short_minor for x in short)
        own_card = [x.days for x in by.get("card", [])]
        compare = statistics.fmean(own_card) if own_card else card_days
        main_days = statistics.fmean(x.days for x in xs)
        slower = main_days - compare if compare is not None else None
        arrives_short = short_total >= SHORT_MIN_MINOR and len(short) >= SHORT_MIN_PAYMENTS
        if not arrives_short and not (slower is not None and slower >= SLOWER_DAYS):
            continue
        name = names.get(cid, "A customer")
        how = methods.LABELS[main].lower()
        rate = card_rate(db, today, abroad=main == "international_transfer")
        fee = card_fee(rate, [x.due_minor for x in xs])
        saving = sum(x.short_minor for x in xs) - fee
        left = short_open.get(cid, [])
        left_minor = sum(r.open_minor for r in left)
        facts = {"customer": name, "who pays whom": f"{name} pays you for invoices you sent them",
                 "payments in the last 180 days": len(mine),
                 "paid by": ", ".join(f"{methods.LABELS[m].lower()} ({len(v)})" for m, v in by.items()),
                 f"average days from invoice to payment by {how}": f"{main_days:.0f}"}
        if short:
            facts |= {"arrived short in all": money(short_total), "payments that arrived short": len(short),
                      "largest shortfall": money(max(x.short_minor for x in short))}
        facts[f"card fees for the same {len(xs)} payments, at {rate['label']}"] = money(fee)
        if saving > 0:
            facts["saving if they paid by card instead"] = money(saving)
        if slower is not None and slower >= 1:
            facts["average days to pay by card"] = f"{compare:.0f}"
            facts["days sooner by card"] = f"{slower:.0f}"
        if left_minor:
            facts["left over to record as bank charges"] = money(left_minor)
        said_short = (f"{len(short)} of {name}'s payments by {how} arrived {money(short_total)} short in the last "
                      "180 days, most likely bank charges taken on the way.")
        if arrives_short:
            title, body = f"{name}'s payments arrived {money(short_total)} short", said_short
            if slower is not None and slower >= 1:
                body += f" Card payments also arrive {slower:.0f} days sooner on average."
        else:
            title = f"{name} takes {slower:.0f} days longer to pay by {how}"
            body = (f"{name} pays by {how} {main_days:.0f} days after the invoice on average, against "
                    f"{compare:.0f} by card.")
            if short:
                body += " " + said_short
        body += (f" By card, the same payments would have cost about {money(fee)} in fees" +
                 (f", saving {money(saving)}." if saving > 0 else "."))
        body += " Try sending a card payment link with the next reminder."
        if left_minor:
            body += f" Record the {money(left_minor)} left over as bank charges, so those invoices show as paid."
        detail = {"methods": method_table(db, mine, today), "card_rate": rate, "main_method": main,
                  "short_minor": short_total, "short_payments": len(short), "card_fee_minor": fee,
                  "saving_minor": max(saving, 0),
                  "days_sooner_by_card": round(slower, 1) if slower is not None else None,
                  "leftovers": [{"record_id": str(r.id), "reference": r.reference, "short_minor": r.open_minor}
                                for r in left],
                  "leftover_minor": left_minor, "links_configured": payment_links.configured(),
                  "tip": "Send a card payment link with the next reminder"}
        step = ({"label": f"Record {money(left_minor)} as bank charges", "action": "record_bank_charge",
                 "record_ids": [str(r.id) for r in left]} if left else
                {"label": "Send a card payment link with the next reminder", "action": None})
        out.append(Finding(
            kind="payment_costs", fingerprint=f"costs:{cid}", counterparty_id=cid,
            severity="warning" if short_total >= 100_00 else "watch",
            money_at_stake_minor=max(short_total, saving, 0), facts=facts, title=title, body=body,
            why=("We look at how each customer paid over the last 180 days. We flag payments that arrived £10 or more "
                 "short over at least 2 payments, or a way of paying that takes 5 or more days longer than card. "
                 + ("Card fees are your own." if rate["source"] == "yours" else
                    f"Card fees use {rate['label']}, as you have too few card payments of your own.")),
            evidence=[{"label": f"Invoice {x.invoice.reference or ''}".strip(), "before": f"{money(x.due_minor)} due",
                       "after": f"{money(x.due_minor - x.short_minor)} arrived on {day(x.on)}",
                       "record_id": str(x.invoice.id)} for x in sorted(short, key=lambda x: x.on)[-6:]]
            + [{"label": f"Card fees at {rate['label']}", "before": "", "after": money(fee)}],
            next_step={**step, "getting_paid": detail},
            measure=short_total or (slower or 0),
        ))
    return out


# ── Reminders that escalate ────────────────────────────────────────────────


def sent(db: Session, record_ids) -> dict:
    """Reminders already sent: record id -> {stage: day sent}."""
    out: dict = defaultdict(dict)
    if record_ids:
        for rid, stage, at in db.execute(select(Reminder.record_id, Reminder.stage, Reminder.sent_at)
                                         .where(Reminder.record_id.in_(record_ids))).all():
            out[rid][stage] = sent_day(at)
    return out


def sent_day(at: datetime) -> date:
    """The day a reminder went out, on the same calendar as date.today(), not in UTC."""
    return at.astimezone().date()


def next_stage(due: date, done: dict) -> tuple[int, date] | None:
    """The next reminder for one overdue invoice, and the day it is due; None after the final notice."""
    last = max(done, default=0)
    if last >= LAST_STAGE:
        return None
    stage = last + 1
    ready = due + timedelta(days=1) if stage == 1 else done[last] + timedelta(days=STAGE_AFTER[stage])
    return stage, ready


def _link_kind(r: Record, configured: bool) -> str:
    if r.source == "stripe" and payment_links.safe_url((r.external or {}).get("hosted_invoice_url")):
        return "invoice_page"
    return "card_link" if configured else "none"


def _days(n: int) -> str:
    return "1 day" if n == 1 else f"{n} days"


def chase_overdue(db: Session, today: date) -> list[Finding]:
    names, terms = ledger.names(db), ledger.terms(db)
    invoices, _ = ledger.open_items(db, "invoice")  # never what is left after a payment arrived short
    # A payment that looks like it paid the invoice, waiting for a person to confirm: don't chase it
    waiting = set(db.execute(select(Match.left_id).where(Match.status == "suggested")).scalars())
    overdue = [r for r in invoices if r.counterparty_id and ledger.due(r, terms) < today and r.id not in waiting]
    done = sent(db, [r.id for r in overdue])
    ready: dict = defaultdict(list)
    for r in overdue:
        n = next_stage(ledger.due(r, terms), done.get(r.id, {}))
        if n and n[1] <= today:
            ready[r.counterparty_id].append((n[0], r))
    configured = payment_links.configured()
    out = []
    for cid, items in ready.items():
        stage = max(s for s, _ in items)
        covered = sorted((r for s, r in items if s == stage), key=lambda r: ledger.due(r, terms))
        name = names.get(cid, "A customer")
        total = sum(r.open_minor for r in covered)
        earlier = sorted({(s, d) for r in covered for s, d in done.get(r.id, {}).items()})
        links = [_link_kind(r, configured) for r in covered]
        listed = [{"record_id": str(r.id), "reference": r.reference, "open_minor": r.open_minor,
                   "due": ledger.due(r, terms).isoformat(), "days_overdue": (today - ledger.due(r, terms)).days,
                   "link": k} for r, k in zip(covered, links, strict=True)]
        facts = {"customer": name, "who owes whom": f"{name} owes you for invoices you sent them",
                 "reminder": f"{stage} of {LAST_STAGE} ({STAGES[stage]})",
                 "invoices": [f"{r.reference or 'invoice'}: {money(r.open_minor)}, due {day(ledger.due(r, terms))}, "
                              f"{_days((today - ledger.due(r, terms)).days)} overdue" for r in covered[:8]],
                 "total overdue on these invoices": money(total)}
        if earlier:
            facts["earlier reminders"] = [f"reminder {s} sent on {day(d)}" for s, d in earlier]
        title = {1: f"{name} has {money(total)} overdue: send a friendly reminder",
                 2: f"{name} still owes {money(total)}: send a firmer reminder",
                 3: f"{name} still hasn't paid {money(total)}: send a final notice"}[stage]
        body = {1: f"{len(covered)} invoice{'s' if len(covered) > 1 else ''} to {name}, {money(total)} in all, "
                   "passed the due date. A friendly reminder now is the cheapest way to get paid.",
                2: f"{name} hasn't paid {money(total)} since our first reminder on {day(earlier[-1][1])}. "
                   "A firmer second reminder is due." if earlier else "",
                3: f"{name} still owes {money(total)} after two reminders. A final notice is due; a business owner "
                   "approves it before it is sent." if earlier else ""}[stage]
        link_text = {"none": "Add a payment link key to include a card payment link.",
                     "card_link": "It includes a card payment link, made only once the reminder is approved.",
                     "invoice_page": "It includes the link to pay the invoice online."}
        body += " " + link_text["card_link" if "card_link" in links else "invoice_page" if "invoice_page" in links
                                else "none"]
        out.append(Finding(
            kind="chase_overdue", fingerprint=f"remind:{cid}:{stage}", counterparty_id=cid,
            severity="watch" if stage == 1 else "warning", money_at_stake_minor=total, facts=facts,
            title=title, body=body.strip(),
            why="Reminders go out in three steps: a friendly one once an invoice is overdue, a firmer one 7 days "
                "later, and a final notice 14 days after that, which a business owner approves. Nothing is sent "
                "until someone approves it.",
            evidence=[{"label": f"Invoice {r.reference or ''}".strip(), "before": f"due {day(ledger.due(r, terms))}",
                       "after": money(r.open_minor), "record_id": str(r.id)} for r in covered[:8]]
            + [{"label": f"Reminder {s}", "before": "", "after": f"sent {day(d)}"} for s, d in earlier],
            next_step={"label": (f"Draft reminder {stage} of {LAST_STAGE} to {name}" if stage < LAST_STAGE
                                 else f"Draft the final notice to {name}"),
                       "action": "send_payment_reminder", "stage": stage, "record_ids": [str(r.id) for r in covered],
                       "purpose": PURPOSE[stage],
                       "getting_paid": {"reminder": {"stage": stage, "of": LAST_STAGE, "tone": STAGES[stage],
                                                     "invoices": listed, "owner_only": stage == LAST_STAGE,
                                                     "previous": [{"stage": s, "sent_on": d.isoformat()}
                                                                  for s, d in earlier],
                                                     "link": "none" if set(links) == {"none"} else
                                                     "all" if "none" not in links else "some",
                                                     "links_configured": configured}}},
            measure=total,
        ))
    return out


PURPOSE = {
    1: "a friendly reminder that these invoices are overdue, asking when they will be paid",
    2: "a firmer second reminder: these invoices are still unpaid after our first reminder; ask them to pay "
       "now or tell us what is holding payment up",
    3: "a final notice: these invoices are still unpaid after two reminders; ask them to pay now or contact us "
       "straight away to agree a plan. Stay polite",
}


# ── The numbers ────────────────────────────────────────────────────────────


def numbers(db: Session, today: date | None = None) -> dict:
    """What getting paid costs and how long it takes, for the last 180 days."""
    today = today or date.today()
    rows = _paid(db, today)
    table = method_table(db, rows, today)
    card_days = _card_days(rows)
    transfer = [x.days for x in rows if x.method in TRANSFERS]
    saving = 0
    per: dict = defaultdict(list)
    for x in rows:
        if x.method != "card" and x.short_minor:
            per[(x.invoice.counterparty_id, x.method)].append(x)
    for (_, method), xs in per.items():
        rate = card_rate(db, today, abroad=method == "international_transfer")
        saving += max(0, sum(x.short_minor for x in xs) - card_fee(rate, [x.due_minor for x in xs]))
    left = [x.record for x in ledger.short_paid(db).values() if x.record.status == "open" and x.record.open_minor > 0]
    # The reminder stage each invoice had reached when it was paid
    reached = sent(db, list({x.invoice.id for x in rows}))
    stages: dict = defaultdict(lambda: {"invoices": 0, "amount_minor": 0, "days": []})
    for x in {x.invoice.id: x for x in rows}.values():
        stage = max((s for s, d in reached.get(x.invoice.id, {}).items() if d <= x.on), default=0)
        stages[stage]["invoices"] += 1
        stages[stage]["amount_minor"] += x.due_minor
        stages[stage]["days"].append(x.days)
    return {
        "since": (today - timedelta(days=LOOKBACK_DAYS)).isoformat(), "days": LOOKBACK_DAYS,
        "lost_to_short_minor": sum(x.short_minor for x in rows),
        "short_payments": sum(1 for x in rows if x.short_minor),
        "could_save_minor": saving,
        "days_to_pay_by_card": round(card_days, 1) if card_days is not None else None,
        "days_to_pay_by_transfer": round(statistics.fmean(transfer), 1) if len(transfer) >= CARD_DAYS_MIN else None,
        "days_sooner_by_card": round(statistics.fmean(transfer) - card_days, 1)
        if card_days is not None and len(transfer) >= CARD_DAYS_MIN else None,
        "left_to_record_minor": sum(r.open_minor for r in left), "left_to_record_count": len(left),
        "methods": table,
        "card_rate": card_rate(db, today), "card_rate_abroad": card_rate(db, today, abroad=True),
        "paid_after_reminder": [{"stage": s, "invoices": v["invoices"], "amount_minor": v["amount_minor"],
                                 "days_to_pay": round(statistics.fmean(v["days"]), 1)}
                                for s, v in sorted(stages.items())],
        "links_configured": payment_links.configured(), "links_problem": payment_links.problem(),
    }
