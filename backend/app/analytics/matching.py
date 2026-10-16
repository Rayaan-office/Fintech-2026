"""Matching payments to what they settle.

Pairs we look for:
  invoice  <- payment_in   (a customer paid us; card payment or bank credit)
  bill     <- payment_out  (we paid a supplier; bank debit)
  payout   <- bank credit  (the payment platform sent money to the bank)

Step 1: exact rules settle most cases. Step 2: points for each signal.
85+ is a confident match (automatic if the approval rules allow), 60-84 a suggestion
for a person, below 60 left unmatched. One payment may settle several invoices.
"""

import itertools
import re
from dataclasses import dataclass, field
from datetime import date

from rapidfuzz import fuzz
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Counterparty, Match, Record

CONFIDENT = 85
SUGGEST = 60
MAX_COMBINATION = 4


@dataclass
class Candidate:
    target: Record  # invoice, bill or payout
    payment: Record
    score: int
    rule: str
    signals: dict = field(default_factory=dict)
    amount_minor: int = 0


def _fee_ok(target_amount: int, paid: int) -> bool:
    """Same amount, allowing small payment-platform fees (up to 3% + 50p)."""
    if paid == target_amount:
        return True
    diff = target_amount - paid
    return 0 < diff <= int(target_amount * 0.03) + 50


def _norm_ref(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _ref_found(target: Record, payment: Record) -> bool:
    ref = _norm_ref(target.reference)
    if len(ref) < 3:
        return False
    hay = _norm_ref(" ".join(filter(None, [payment.reference, payment.description,
                                           str(payment.external.get("invoice") or "")])))
    return ref in hay or (target.external.get("stripe_invoice") and
                          target.external.get("stripe_invoice") == payment.external.get("invoice"))


def _names(db: Session, ids: set) -> dict:
    if not ids:
        return {}
    return {c.id: c.display_name for c in db.execute(select(Counterparty).where(Counterparty.id.in_(ids))).scalars()}


def score(target: Record, payment: Record, names: dict, today: date | None = None) -> Candidate:
    signals: dict = {}
    pts = 0
    amount_ok = _fee_ok(target.open_minor or target.amount_minor, payment.amount_minor)
    if amount_ok:
        pts += 40
        signals["amount"] = 40
    if _ref_found(target, payment):
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
    a = names.get(target.counterparty_id) or ""
    b = names.get(payment.counterparty_id) or payment.description or ""
    if a and b and fuzz.token_set_ratio(a.lower(), b.lower()) >= 80:
        pts += 10
        signals["name"] = 10
    return Candidate(target, payment, pts, "score", signals, min(payment.amount_minor, target.open_minor or 0))


def _exact(target: Record, payment: Record, names: dict) -> Candidate | None:
    if target.kind == "payout" and payment.external.get("payout_id") and \
            payment.external.get("payout_id") == target.source_ref:
        return Candidate(target, payment, 100, "payout_id", {"payout_id": 100}, payment.amount_minor)
    if target.external.get("stripe_invoice") and target.external.get("stripe_invoice") == payment.external.get("invoice"):
        return Candidate(target, payment, 100, "platform_invoice_id", {"invoice_id": 100},
                         min(payment.amount_minor, target.open_minor))
    same_party = target.counterparty_id and target.counterparty_id == payment.counterparty_id
    if _ref_found(target, payment) and _fee_ok(target.open_minor, payment.amount_minor):
        return Candidate(target, payment, 100, "invoice_number", {"reference": 100},
                         min(payment.amount_minor, target.open_minor))
    if same_party and payment.amount_minor == target.open_minor and payment.date == (target.due_date or target.date):
        return Candidate(target, payment, 100, "amount_party_date", {"exact": 100}, payment.amount_minor)
    return None


PAIRS = {
    # target kind -> (payment kinds, payment direction)
    "invoice": (("payment_in", "bank_txn"), "in"),
    "bill": (("payment_out", "bank_txn"), "out"),
    "payout": (("bank_txn",), "in"),
}


def _matched_ids(db: Session) -> tuple[set, set]:
    rows = db.execute(select(Match.left_id, Match.right_id).where(Match.status.in_(("accepted", "suggested")))).all()
    return {r[0] for r in rows}, {r[1] for r in rows}


def find_candidates(db: Session) -> list[Candidate]:
    """Best candidate for every unmatched payment."""
    matched_targets, matched_payments = _matched_ids(db)
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
        names = _names(db, {r.counterparty_id for r in targets + payments if r.counterparty_id})
        used_targets: set = set()
        for p in sorted(payments, key=lambda r: r.date):
            best: Candidate | None = None
            for t in targets:
                if t.id in used_targets or t.date > p.date:
                    continue
                c = _exact(t, p, names) or score(t, p, names)
                if not best or c.score > best.score:
                    best = c
            if best and best.score >= SUGGEST:
                out.append(best)
                if best.score >= CONFIDENT:
                    used_targets.add(best.target.id)
            elif tkind != "payout":
                out.extend(_combinations(p, [t for t in targets if t.id not in used_targets], names))
    return out


def _combinations(payment: Record, targets: list[Record], names: dict) -> list[Candidate]:
    """One payment that settles several open items from the same party."""
    same = [t for t in targets if t.counterparty_id and t.counterparty_id == payment.counterparty_id
            and t.date <= payment.date]
    if not payment.counterparty_id:
        b = payment.description or ""
        same = [t for t in targets if t.date <= payment.date and names.get(t.counterparty_id)
                and fuzz.token_set_ratio(names[t.counterparty_id].lower(), b.lower()) >= 80]
    for n in range(2, min(MAX_COMBINATION, len(same)) + 1):
        for combo in itertools.combinations(same[:12], n):
            if sum(t.open_minor for t in combo) == payment.amount_minor:
                return [Candidate(t, payment, 80, "combination", {"combination": n, "amount": 40, "name": 10},
                                  t.open_minor) for t in combo]
    return []


def apply(db: Session, c: Candidate, status: str, decided_by: str) -> Match:
    """Save a match; when accepted, reduce what is still owed."""
    m = db.execute(select(Match).where(Match.left_id == c.target.id, Match.right_id == c.payment.id)).scalar_one_or_none()
    if not m:
        m = Match(business_id=c.target.business_id, left_id=c.target.id, right_id=c.payment.id,
                  amount_minor=c.amount_minor, score=c.score, rule=c.rule, signals=c.signals, status=status,
                  decided_by=decided_by)
        db.add(m)
    else:
        m.status, m.decided_by = status, decided_by
    if status == "accepted":
        settle(db, c.target, c.amount_minor, c.payment.date)
    db.flush()
    return m


def settle(db: Session, target: Record, amount: int, on: date) -> None:
    if target.kind in ("invoice", "bill"):
        target.open_minor = max(0, (target.open_minor or 0) - amount)
        if target.open_minor == 0:
            target.status = "paid"
            target.paid_date = on


def unsettle(db: Session, m: Match) -> None:
    target = db.get(Record, m.left_id)
    if target.kind in ("invoice", "bill"):
        target.open_minor = min(target.amount_minor, (target.open_minor or 0) + m.amount_minor)
        target.status = "open"
        target.paid_date = None
    m.status = "rejected"
