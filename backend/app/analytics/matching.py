"""Matching payments to what they settle.

Pairs we look for:
  invoice  <- payment_in   (a customer paid us; card payment or bank credit)
  bill     <- payment_out  (we paid a supplier; bank debit)
  payout   <- bank credit  (the payment platform sent money to the bank)

Step 1: exact rules settle most cases. Step 2: points for each signal.
85+ is a confident match (automatic if the approval rules allow), 60-84 a suggestion
for a person, below 60 left unmatched. One payment may settle several invoices.

Never suggested: a payment that names a different invoice or bill, or a different customer
or supplier; and pairs from the same accounting or payment system, which links its own
payments (QuickBooks and Stripe tell us exactly what each payment settled).

A bank payment that names an invoice or bill the accounting software already shows as paid
is the same money arriving: we link the two ("already settled") without changing either.

A payment a little below the invoice (within the fee allowance) records how much arrived short.
What is left is a bank charge, not a debt: it is never chased (see ledger.short_paid).
"""

import itertools
import re
from dataclasses import dataclass, field

from rapidfuzz import fuzz
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Counterparty, Match, Record
from . import methods

CONFIDENT = 85
SUGGEST = 60
MAX_COMBINATION = 4
SAME_NAME = 80  # name similarity (0-100) that counts as the same party
OTHER_NAME = 90  # a known party named this clearly in a payment is a different party
LINKS_OWN = ("quickbooks", "stripe")  # systems that record which payment settled what
INTL_CHARGE = 30_00  # the most an international transfer may arrive short and still match


@dataclass
class Candidate:
    target: Record  # invoice, bill or payout
    payment: Record
    score: int
    rule: str
    signals: dict = field(default_factory=dict)
    amount_minor: int = 0


@dataclass
class Context:
    names: dict  # counterparty id -> display name
    parties: dict  # "customer" | "supplier" -> every known name
    refs: dict  # "invoice" | "bill" -> every known document number, normalised
    grams: dict = field(default_factory=dict)  # payment id -> word runs in its text
    named: dict = field(default_factory=dict)  # (payment id, side) -> known names it mentions


def _fee_ok(target_amount: int, paid: int, international: bool = False) -> bool:
    """Same amount, allowing small payment-platform fees (up to 3% + 50p). An international transfer
    often loses a fixed charge on the way instead, so for one we allow up to £30 (at most 10%)."""
    if paid == target_amount:
        return True
    diff = target_amount - paid
    allowed = int(target_amount * 0.03) + 50
    if international:
        allowed = max(allowed, min(INTL_CHARGE, target_amount // 10))
    return 0 < diff <= allowed


def _international(payment: Record) -> bool:
    return payment.kind == "bank_txn" and methods.of(payment) == "international_transfer"


def _norm_ref(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _is_ref(s: str) -> bool:
    return len(s) >= 3 and any(ch.isdigit() for ch in s)


def _text(payment: Record) -> str:
    return " ".join(filter(None, [payment.reference, payment.description, str(payment.external.get("invoice") or "")]))


def _grams(ctx: Context, payment: Record) -> set:
    """Runs of one to three words, joined: 'REF INV-2045' gives inv2045, so a number is only
    found whole (INV-204 is not found in INV-2045)."""
    if payment.id not in ctx.grams:
        words = re.findall(r"[a-z0-9]+", _text(payment).lower())
        ctx.grams[payment.id] = {"".join(words[i:i + n]) for n in (1, 2, 3) for i in range(len(words) - n + 1)}
    return ctx.grams[payment.id]


def _ref_found(target: Record, payment: Record, ctx: Context) -> bool:
    if target.external.get("stripe_invoice") and target.external.get("stripe_invoice") == payment.external.get("invoice"):
        return True
    ref = _norm_ref(target.reference)
    return _is_ref(ref) and ref in _grams(ctx, payment)


def _other_ref(target: Record, payment: Record, ctx: Context) -> bool:
    """The payment names another invoice or bill of ours, so it paid that one."""
    own = _norm_ref(target.reference)
    grams = _grams(ctx, payment)
    return any(r in grams and r not in own for r in ctx.refs.get(target.kind, ()))


def _side(target: Record) -> str:
    return "supplier" if target.kind == "bill" else "customer"


def _party(target: Record, payment: Record, ctx: Context) -> str:
    """'same', 'other' (the payment is clearly from someone else) or 'unknown'."""
    a = (ctx.names.get(target.counterparty_id) or "").lower()
    texts = [t.lower() for t in (ctx.names.get(payment.counterparty_id), payment.description) if t]
    if a and any(fuzz.token_set_ratio(a, t) >= SAME_NAME for t in texts):
        return "same"
    key = (payment.id, _side(target))
    if key not in ctx.named:
        ctx.named[key] = {n for n in ctx.parties.get(_side(target), ()) for t in texts
                          if len(n) >= 6 and fuzz.token_set_ratio(n, t) >= OTHER_NAME}
    return "other" if ctx.named[key] - {a} else "unknown"


def _excluded(target: Record, payment: Record, ctx: Context) -> str | None:
    if target.source == payment.source and target.source in LINKS_OWN:
        return "same_system"
    if payment.source == "quickbooks" and payment.external.get("linked"):
        return "settled_in_source"  # QuickBooks already says what this payment paid
    if payment.source == "stripe" and payment.external.get("invoice") and \
            payment.external.get("invoice") != target.external.get("stripe_invoice"):
        return "settled_in_source"
    if not _ref_found(target, payment, ctx) and _other_ref(target, payment, ctx):
        return "different_reference"
    if _party(target, payment, ctx) == "other":
        return "different_party"
    return None


def score(target: Record, payment: Record, ctx: Context) -> Candidate:
    out = _excluded(target, payment, ctx)
    if out:
        return Candidate(target, payment, 0, out)
    signals: dict = {}
    pts = 0
    if _fee_ok(target.open_minor or target.amount_minor, payment.amount_minor, _international(payment)):
        pts += 40
        signals["amount"] = 40
    if _ref_found(target, payment, ctx):
        pts += 30
        signals["reference"] = 30
    anchor = target.due_date or target.date
    days = abs((payment.date - anchor).days) if anchor else 999
    days_from_issue = (payment.date - target.date).days
    if days <= 3 or (0 <= days_from_issue and days <= 7):
        pts += 20
        signals["dates"] = 20
    elif days <= 14:
        pts += 10
        signals["dates"] = 10
    if _party(target, payment, ctx) == "same":
        pts += 10
        signals["name"] = 10
    return Candidate(target, payment, pts, "score", signals, min(payment.amount_minor, target.open_minor or 0))


def _exact(target: Record, payment: Record, ctx: Context) -> Candidate | None:
    if target.kind == "payout" and payment.external.get("payout_id") and \
            payment.external.get("payout_id") == target.source_ref:
        return Candidate(target, payment, 100, "payout_id", {"payout_id": 100}, payment.amount_minor)
    if _excluded(target, payment, ctx):
        return None
    if target.external.get("stripe_invoice") and target.external.get("stripe_invoice") == payment.external.get("invoice"):
        return Candidate(target, payment, 100, "platform_invoice_id", {"invoice_id": 100},
                         min(payment.amount_minor, target.open_minor))
    if _ref_found(target, payment, ctx) and _fee_ok(target.open_minor, payment.amount_minor,
                                                    _international(payment)):
        return Candidate(target, payment, 100, "invoice_number", {"reference": 100},
                         min(payment.amount_minor, target.open_minor))
    same_party = target.counterparty_id and target.counterparty_id == payment.counterparty_id
    if same_party and payment.amount_minor == target.open_minor and payment.date == (target.due_date or target.date):
        return Candidate(target, payment, 100, "amount_party_date", {"exact": 100}, payment.amount_minor)
    return None


PAIRS = {
    # target kind -> (payment kinds, payment direction)
    "invoice": (("payment_in", "bank_txn"), "in"),
    "bill": (("payment_out", "bank_txn"), "out"),
    "payout": (("bank_txn",), "in"),
}


def _decided(db: Session) -> tuple[set, set, set]:
    """Targets and payments already in a match, and every pair a person turned down."""
    rows = db.execute(select(Match.left_id, Match.right_id, Match.status)).all()
    live = [r for r in rows if r[2] in ("accepted", "suggested")]
    return {r[0] for r in live}, {r[1] for r in live}, {(r[0], r[1]) for r in rows if r[2] == "rejected"}


def context(db: Session) -> Context:
    cps = db.execute(select(Counterparty)).scalars().all()
    parties: dict = {"customer": set(), "supplier": set()}
    for c in cps:
        parties.setdefault(c.kind, set()).add(c.display_name.lower())
    refs: dict = {"invoice": set(), "bill": set()}
    for kind, ref in db.execute(select(Record.kind, Record.reference).where(
            Record.kind.in_(("invoice", "bill")), Record.reference.is_not(None))).all():
        if _is_ref(_norm_ref(ref)):
            refs[kind].add(_norm_ref(ref))
    return Context({c.id: c.display_name for c in cps}, parties, refs)


def find_candidates(db: Session) -> list[Candidate]:
    """Best candidate for every unmatched payment."""
    matched_targets, matched_payments, rejected = _decided(db)
    ctx = context(db)
    out: list[Candidate] = []
    for tkind, (pkinds, direction) in PAIRS.items():
        targets = db.execute(select(Record).where(
            Record.kind == tkind, Record.status.in_(("open", "posted", "pending")),
            (Record.open_minor > 0) if tkind != "payout" else Record.amount_minor > 0)).scalars().all()
        if tkind == "payout":
            targets = [t for t in targets if t.id not in matched_targets]
            for t in targets:
                t.open_minor = t.open_minor or t.amount_minor
        payments = db.execute(select(Record).where(
            Record.kind.in_(pkinds), Record.direction == direction, Record.status != "void")).scalars().all()
        payments = [p for p in payments if p.id not in matched_payments]
        if tkind == "invoice":  # card payments for invoices arrive as payment_in; bank credits may be payouts
            payments = [p for p in payments if not (p.kind == "bank_txn" and "stripe" in (p.description or "").lower())]
        used_targets: set = set()
        for p in sorted(payments, key=lambda r: r.date):
            best: Candidate | None = None
            for t in targets:
                if t.id in used_targets or t.date > p.date or (t.id, p.id) in rejected:
                    continue
                c = _exact(t, p, ctx) or score(t, p, ctx)
                if not best or c.score > best.score:
                    best = c
            if best and best.score >= SUGGEST:
                out.append(best)
                matched_payments.add(p.id)
                if best.score >= CONFIDENT:
                    used_targets.add(best.target.id)
            elif tkind != "payout":
                combo = _combinations(p, [t for t in targets if t.id not in used_targets
                                          and (t.id, p.id) not in rejected], ctx)
                if combo:
                    matched_payments.add(p.id)
                out.extend(combo)
    return out


def _combinations(payment: Record, targets: list[Record], ctx: Context) -> list[Candidate]:
    """One payment that settles several open items from the same party."""
    same = [t for t in targets if t.date <= payment.date and _party(t, payment, ctx) == "same"
            and not _excluded(t, payment, ctx)]
    for n in range(2, min(MAX_COMBINATION, len(same)) + 1):
        for combo in itertools.combinations(same[:12], n):
            if sum(t.open_minor for t in combo) == payment.amount_minor:
                return [Candidate(t, payment, 80, "combination", {"combination": n, "amount": 40, "name": 10},
                                  t.open_minor) for t in combo]
    return []


def already_settled(db: Session) -> list[Candidate]:
    """Bank payments that are the same money as an invoice or bill the accounting software
    already shows as paid: the bank line names it, or (direct debits and card payments carry
    no number) it is the same party and amount within 3 days of the payment there."""
    _, matched_payments, rejected = _decided(db)
    matched_targets = {r[0] for r in db.execute(select(Match.left_id).where(Match.status == "accepted")).all()}
    ctx = context(db)
    out = []
    for tkind, direction in (("invoice", "in"), ("bill", "out")):
        paid = [t for t in db.execute(select(Record).where(
            Record.kind == tkind, Record.status == "paid", Record.source.in_(LINKS_OWN))).scalars()
            if t.id not in matched_targets]
        by_ref: dict = {}
        for t in paid:
            if _is_ref(_norm_ref(t.reference)):
                by_ref.setdefault(_norm_ref(t.reference), []).append(t)
        bank = [p for p in db.execute(select(Record).where(Record.kind == "bank_txn", Record.direction == direction,
                                                            Record.status != "void")).scalars()
                if p.id not in matched_payments]
        used: set = set()

        def ok(t: Record, p: Record, used: set = used) -> bool:
            return (t.id not in used and t.amount_minor == p.amount_minor and (t.id, p.id) not in rejected
                    and t.currency == p.currency)

        rest = []
        for p in bank:
            grams = _grams(ctx, p)
            found = [t for ref, ts in by_ref.items() if ref in grams for t in ts
                     if ok(t, p) and _party(t, p, ctx) != "other"]
            if len(found) == 1:  # one clear answer only
                used.add(found[0].id)
                out.append(Candidate(found[0], p, 100, "already_settled", {"reference": 100}, 0))
            else:
                rest.append(p)
        for p in rest:
            found = [t for t in paid if ok(t, p) and t.paid_date and abs((p.date - t.paid_date).days) <= 3
                     and _party(t, p, ctx) == "same"]
            if len(found) == 1:
                used.add(found[0].id)
                out.append(Candidate(found[0], p, 100, "already_settled", {"amount": 40, "dates": 20, "name": 10}, 0))
    return out


def still_suggested(db: Session, m: Match) -> bool:
    """Would we still suggest this pair today? Data changes (paid in the accounting software,
    a voided payment) and better rules can both make a suggestion stale."""
    t, p = db.get(Record, m.left_id), db.get(Record, m.right_id)
    if not t or not p or p.status == "void" or t.status in ("void", "paid"):
        return False
    if t.kind in ("invoice", "bill") and t.open_minor <= 0:
        return False
    ctx = context(db)
    c = _exact(t, p, ctx) or score(t, p, ctx)
    return c.score >= SUGGEST or (m.rule == "combination" and not _excluded(t, p, ctx)
                                  and _party(t, p, ctx) == "same")


def short_by(c: Candidate) -> int:
    """How much less than the invoice arrived, when that is within the fee allowance: a bank charge
    taken on the way (common with international transfers), not money the customer still owes."""
    t, p = c.target, c.payment
    if t.kind != "invoice" or c.rule in ("combination", "already_settled") or c.amount_minor != p.amount_minor:
        return 0
    short = (t.open_minor or 0) - p.amount_minor
    return short if short > 0 and _fee_ok(t.open_minor, p.amount_minor, _international(p)) else 0


def apply(db: Session, c: Candidate, status: str, decided_by: str) -> Match:
    """Save a match; when accepted, reduce what is still owed."""
    m = db.execute(select(Match).where(Match.left_id == c.target.id, Match.right_id == c.payment.id)).scalar_one_or_none()
    if not m:
        short = short_by(c)
        m = Match(business_id=c.target.business_id, left_id=c.target.id, right_id=c.payment.id,
                  amount_minor=c.amount_minor, score=c.score, rule=c.rule,
                  signals={**c.signals, "short_minor": short} if short else c.signals, status=status,
                  decided_by=decided_by)
        db.add(m)
    else:
        m.status, m.decided_by = status, decided_by
    if status == "accepted" and c.amount_minor:
        settle(db, c.target, c.amount_minor, c.payment.date)
    db.flush()
    return m


def settle(db: Session, target: Record, amount: int, on) -> None:
    if target.kind in ("invoice", "bill"):
        target.open_minor = max(0, (target.open_minor or 0) - amount)
        if target.open_minor == 0:
            target.status = "paid"
            target.paid_date = on


def unsettle(db: Session, m: Match) -> None:
    """Turn a match down. Only an accepted one changed what is owed, so only that is given back."""
    if m.status == "accepted" and m.amount_minor:
        target = db.get(Record, m.left_id)
        if target.kind in ("invoice", "bill"):
            target.open_minor = min(target.amount_minor, (target.open_minor or 0) + m.amount_minor)
            target.status = "open"
            target.paid_date = None
    m.status = "rejected"
