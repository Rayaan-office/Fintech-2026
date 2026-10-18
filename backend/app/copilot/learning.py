"""Learning from decisions (docs/ALGORITHMS.md, "Learning from decisions").

Two things are learned. Both stay in our database: nothing extra is sent to the AI.

  correction memory   when a person makes the same correction on LEARN_AFTER approved documents
                      from one supplier, with none since that disagree, we fill that value in
                      ourselves next time and say so beside the field, with Undo
  ranking             how often each kind of recommendation is acted on or turned down. Within one
                      severity, kinds are ordered by a Thompson-sampling draw times the money at stake

Bank details, contact details and amounts are never learned. Urgent recommendations and changed
bank details are never moved down or folded away. The owner can reset any of it.
"""

import hashlib
import random
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ..analytics import rules
from ..models import Correction, Counterparty, Document, LearningStat, Recommendation
from ..pipeline import counterparties, extract
from ..security import audit

LEARN_AFTER = 2  # matching corrections before a value is learned
# The only fields we learn, with plain labels. Bank details, contacts and amounts are never here.
LEARNABLE = {"category_hint": "What it's for", "doc_type": "Type", "currency": "Currency"}
TERMS = "payment_terms"  # days from issue to due date, learned from due-date corrections
NAME = "counterparty_name"  # what the AI reads -> the real supplier
LABELS = {**LEARNABLE, TERMS: "Payment terms", NAME: "Supplier name"}
DOC_TYPES = {"bill": "bill to pay", "invoice": "invoice we sent", "receipt": "receipt", "credit_note": "credit note",
             "payment_notice": "payment notice", "other": "something else"}
# Where a learned value lands on the form, and the corrections it is learned from
FORM_FIELD = {TERMS: "due_date"}
SOURCE_FIELDS = {TERMS: ("issue_date", "due_date")}
# Learned values that still need a person: only a learned category may be recorded automatically
CHECK_FIRST = {"doc_type", "currency", "due_date", NAME}

SECONDS_PER_FIELD = 30  # assumption: finding and retyping one value takes a person about 30 seconds

FOLD_AFTER = 5  # decisions on a kind before it may be folded away
FOLD_BELOW = 0.2  # acted on less than this share of the time
FOLD_MAX_SEVERITY = "watch"  # only minor kinds are folded
PINNED_KINDS = {"bank_details_changed"}  # never moved down or folded
TOP_ARM = "@top"  # decisions on whatever was first in the list, for "how often the top one is acted on"
PRIOR_MEAN = 0.5  # a kind with no decisions yet keeps the middle value, so the order stays by money

KIND_LABELS = {
    "supplier_details_changed": "Supplier details changed", "bank_details_changed": "Bank details changed",
    "price_rise": "Price rise", "slow_payer": "Slow-paying customer", "spending_creep": "Spending creep",
    "customer_concentration": "Reliance on one customer",
}


# ── Correction memory ──────────────────────────────────────────────────────


def _norm(field: str, value) -> str:
    v = str(value or "").strip()
    if field == "currency":
        return v.upper()
    return v.lower() if field in ("category_hint", "doc_type") else v


def _terms(fields: dict) -> int | None:
    issue, due = extract.to_date(fields.get("issue_date")), extract.to_date(fields.get("due_date"))
    if not issue or not due:
        return None
    days = (due - issue).days
    return days if 0 <= days <= 365 else None


def _valid(field: str, value) -> bool:
    if value in (None, ""):
        return False
    if field == "doc_type":
        return value in DOC_TYPES
    if field == "currency":
        return value in extract.CURRENCIES
    if field == "category_hint":
        return len(str(value)) <= 80
    return field == TERMS


def _first_ai_values(db: Session, document_ids: list) -> tuple[dict, set]:
    """The AI's own answer for each corrected (document, field), and the pairs the owner asked us to forget."""
    first: dict[tuple, str | None] = {}
    forgotten: set[tuple] = set()
    if not document_ids:
        return first, forgotten
    rows = db.execute(select(Correction).where(Correction.document_id.in_(document_ids))
                      .order_by(Correction.created_at)).scalars()
    for c in rows:
        first.setdefault((c.document_id, c.field), c.ai_value)
        if c.forgotten_at is not None:
            forgotten.add((c.document_id, c.field))
    return first, forgotten


def learned_fields(db: Session, counterparty_id) -> dict[str, dict]:
    """What we have learned for one supplier or customer: {field: {"value", "corrections"}}.

    Only approved documents count. A value is learned after LEARN_AFTER documents where a person
    changed the AI's answer to it, with no later document that ended up different."""
    docs = db.execute(select(Document).where(Document.counterparty_id == counterparty_id,
                                             Document.status == "approved")
                      .order_by(Document.created_at, Document.id)).scalars().all()
    first, forgotten = _first_ai_values(db, [d.id for d in docs])
    out = {}
    for field in [*LEARNABLE, TERMS]:
        sources = SOURCE_FIELDS.get(field, (field,))
        value, shown, streak = None, None, 0
        for d in docs:
            f = d.fields or {}
            if any((d.id, s) in forgotten for s in sources):
                continue
            if field == TERMS:
                final = _terms(f)
                ai = _terms({s: first.get((d.id, s), f.get(s)) for s in sources})
                corrected = any((d.id, s) in first for s in sources) and final != ai
            else:
                final = _norm(field, f.get(field))
                corrected = (d.id, field) in first and _norm(field, first[(d.id, field)]) != final
            if corrected and _valid(field, final if field == TERMS else f.get(field)):
                if final == value:
                    streak += 1
                else:
                    value, streak = final, 1
                shown = final if field == TERMS else str(f.get(field)).strip()  # the latest spelling
            elif value is not None and final not in (None, "") and final != value:
                value, streak = None, 0  # a later document disagrees
        if value is not None and streak >= LEARN_AFTER:
            out[field] = {"value": shown, "corrections": streak}
    return out


def learned_aliases(db: Session) -> dict[str, dict]:
    """Names the AI reads that a person keeps correcting to the same supplier or customer:
    {normalized AI name: {"counterparty_id", "name", "ai_name", "corrections"}}."""
    docs = db.execute(select(Document).where(Document.status == "approved", Document.counterparty_id.is_not(None))
                      .order_by(Document.created_at, Document.id)).scalars().all()
    first, forgotten = _first_ai_values(db, [d.id for d in docs])
    streaks: dict[str, list] = {}  # key -> [counterparty id, count, AI name]
    for d in docs:
        if (d.id, NAME) in forgotten:
            continue
        ai = first.get((d.id, NAME)) or ""
        key, final = counterparties.normalize(ai), counterparties.normalize((d.fields or {}).get(NAME) or "")
        if key and key != final:
            s = streaks.get(key)
            if s and s[0] == d.counterparty_id:
                s[1] += 1
            else:
                streaks[key] = [d.counterparty_id, 1, ai.strip()]
        elif final in streaks and streaks[final][0] != d.counterparty_id:
            del streaks[final]  # this name was later approved for someone else
    learned = {k: s for k, s in streaks.items() if s[1] >= LEARN_AFTER}
    names = {c.id: c for c in db.execute(select(Counterparty).where(
        Counterparty.id.in_({s[0] for s in learned.values()}))).scalars()} if learned else {}
    return {k: {"counterparty_id": s[0], "name": names[s[0]].display_name, "kind": names[s[0]].kind,
                "ai_name": s[2], "corrections": s[1]} for k, s in learned.items() if s[0] in names}


def fill(db: Session, fields: dict) -> dict[str, dict]:
    """Fill values we learned into a form the AI just filled in (changes `fields` in place).
    Returns what was filled: {form field: {"value", "ai_value", "corrections", "learned_as"}}."""
    filled: dict[str, dict] = {}
    alias = learned_aliases(db).get(counterparties.normalize(fields.get(NAME) or ""))
    cp = None
    if alias:
        cp = db.get(Counterparty, alias["counterparty_id"])
        if alias["name"] != fields.get(NAME):
            filled[NAME] = {"value": alias["name"], "ai_value": fields.get(NAME) or "",
                            "corrections": alias["corrections"], "learned_as": NAME}
            fields[NAME] = alias["name"]
    if cp is None and fields.get(NAME):
        kind = "customer" if fields.get("doc_type") == "invoice" else "supplier"
        other = "supplier" if kind == "customer" else "customer"
        cp = (counterparties.find_or_create(db, None, kind, fields[NAME], create=False)[0]
              or counterparties.find_or_create(db, None, other, fields[NAME], create=False)[0])
    if cp is None:
        return filled
    for field, known in learned_fields(db, cp.id).items():
        if field == TERMS:
            issue = extract.to_date(fields.get("issue_date"))
            if not issue or _terms(fields) == known["value"]:
                continue
            value = (issue + timedelta(days=int(known["value"]))).isoformat()
        else:
            if _norm(field, fields.get(field)) == _norm(field, known["value"]):
                continue
            value = known["value"]
        target = FORM_FIELD.get(field, field)
        filled[target] = {"value": value, "ai_value": fields.get(target) or "", "corrections": known["corrections"],
                          "learned_as": field}
        fields[target] = value
    return filled


def needs_check(filled: dict) -> list[str]:
    """Learned values a person should look at before the document is recorded."""
    return [LABELS.get(v["learned_as"], k).lower() for k, v in filled.items() if k in CHECK_FIRST]


# ── Ranking recommendations ────────────────────────────────────────────────


def stats(db: Session) -> dict[str, LearningStat]:
    return {s.arm: s for s in db.execute(select(LearningStat)).scalars()}


def _draw(business_id, kind: str, today: date, wins: int, losses: int) -> float:
    """A draw from Beta(1 + wins, 1 + losses), the same all day for one business and kind."""
    if wins + losses == 0:
        return PRIOR_MEAN
    seed = int.from_bytes(hashlib.sha256(f"{business_id}:{today.isoformat()}:{kind}".encode()).digest()[:8], "big")
    return random.Random(seed).betavariate(1 + wins, 1 + losses)


def pinned(r: Recommendation) -> bool:
    """Urgent items and changed bank details keep their place, whatever was learned."""
    return r.severity == "urgent" or r.kind in PINNED_KINDS


def order(db: Session, business_id, recs: list[Recommendation], today: date | None = None) -> list[Recommendation]:
    """The recommendations in the order to show them, using what was learned for this business."""
    return rank(recs, stats(db), business_id, today or date.today())


def rank(recs: list, st: dict, business_id, today: date) -> list:
    """Reorder within each severity only. Pinned items come first in their group, in their usual order;
    the rest by the sampled share acted on times the money at stake."""
    draws: dict[str, float] = {}

    def draw(kind: str) -> float:
        if kind not in draws:
            s = st.get(kind)
            draws[kind] = _draw(business_id, kind, today, s.wins if s else 0, s.losses if s else 0)
        return draws[kind]

    out = []
    for sev in sorted({r.severity for r in recs}, key=lambda s: -rules.SEVERITY_ORDER.get(s, 0)):
        group = [r for r in recs if r.severity == sev]
        fixed = [r for r in group if pinned(r)]
        rest = sorted((r for r in group if not pinned(r)),
                      key=lambda r: -draw(r.kind) * ((r.money_at_stake_minor or 0) + 1))
        out += fixed + rest
    return out


def less_useful(s: LearningStat | None, r: Recommendation) -> bool:
    """Acted on less than FOLD_BELOW of the time after FOLD_AFTER decisions, and minor: shown folded."""
    if s is None or pinned(r) or rules.SEVERITY_ORDER.get(r.severity, 9) > rules.SEVERITY_ORDER[FOLD_MAX_SEVERITY]:
        return False
    n = s.wins + s.losses
    return n >= FOLD_AFTER and s.wins / n < FOLD_BELOW


def folded(db: Session, recs: list[Recommendation]) -> set:
    st = stats(db)
    return {r.id for r in recs if less_useful(st.get(r.kind), r)}


def _bump(db: Session, business_id, arm: str, wins: int, losses: int) -> None:
    now = datetime.now(UTC)
    stmt = insert(LearningStat).values(business_id=business_id, arm=arm, wins=max(wins, 0), losses=max(losses, 0),
                                       updated_at=now)
    db.execute(stmt.on_conflict_do_update(
        index_elements=["business_id", "arm"],
        set_={"wins": func.greatest(LearningStat.wins + wins, 0),
              "losses": func.greatest(LearningStat.losses + losses, 0), "updated_at": now}))


def reward(db: Session, rec: Recommendation, won: bool, actor: str, today: date | None = None) -> None:
    """Count one decision on a recommendation: acted on (won) or turned down. A later decision on the
    same one (the drafted email was rejected after all) replaces the earlier one, so nothing counts twice."""
    facts = dict(rec.facts or {})
    before = facts.get("outcome")
    now = "acted_on" if won else "turned_down"
    if before == now:
        return
    rank = facts.get("outcome_rank")
    if before is None:
        shown = db.execute(select(Recommendation).where(Recommendation.status == "new")
                           .order_by(Recommendation.score.desc(), Recommendation.updated_at.desc())).scalars().all()
        ranked = order(db, rec.business_id, shown, today)
        rank = next((i + 1 for i, r in enumerate(ranked) if r.id == rec.id), None)
    w = int(won) - int(before == "acted_on")
    lo = int(not won) - int(before == "turned_down")
    _bump(db, rec.business_id, rec.kind, w, lo)
    if rank == 1:
        _bump(db, rec.business_id, TOP_ARM, w, lo)
    rec.facts = {**facts, "outcome": now, "outcome_rank": rank}
    audit.record(db, rec.business_id, actor, "recommendation_outcome", subject=f"recommendation:{rec.id}",
                 details={"kind": rec.kind, "outcome": now, "rank": rank, "replaced": before})


def reward_action(db: Session, action, won: bool, actor: str) -> None:
    """An approval that came from a recommendation's next step: approved and done, or rejected."""
    rid = (action.payload or {}).get("recommendation_id")
    if not rid:
        return
    rec = db.get(Recommendation, UUID(str(rid)))
    if rec:
        reward(db, rec, won, actor)


# ── What we learned, in plain words ────────────────────────────────────────


def _value_words(field: str, value) -> str:
    if field == TERMS:
        return f"{value} days" if value != 0 else "due on the day"
    if field == "doc_type":
        return DOC_TYPES.get(value, value)
    return str(value)


def _sentence(field: str, item: dict, ai_name: str | None = None) -> str:
    n = item["corrections"]
    times = f"you corrected it on {n} documents" if n != 1 else "you corrected it once"
    if field == NAME:
        return f"When the AI reads “{ai_name}”, we use this supplier or customer: {times}."
    return f"We fill in {LABELS[field].lower()} as “{_value_words(field, item['value'])}”: {times}."


def kind_label(kind: str) -> str:
    return KIND_LABELS.get(kind) or kind.replace("_", " ").capitalize()


def summary(db: Session) -> dict:
    """Everything we learned, with the numbers behind it."""
    cps = {c.id: c for c in db.execute(select(Counterparty)).scalars()}
    cp_ids = {d for (d,) in db.execute(select(Document.counterparty_id).where(
        Document.status == "approved", Document.counterparty_id.is_not(None),
        Document.id.in_(select(Correction.document_id).where(Correction.forgotten_at.is_(None))))).all()}
    by_cp: dict = {}
    for cid in cp_ids:
        for field, item in learned_fields(db, cid).items():
            by_cp.setdefault(cid, []).append({"field": field, "label": LABELS[field], "value": item["value"],
                                              "value_label": _value_words(field, item["value"]),
                                              "corrections": item["corrections"], "sentence": _sentence(field, item)})
    for a in learned_aliases(db).values():
        by_cp.setdefault(a["counterparty_id"], []).append({
            "field": NAME, "label": LABELS[NAME], "value": a["ai_name"], "value_label": a["ai_name"],
            "corrections": a["corrections"], "sentence": _sentence(NAME, a, a["ai_name"])})
    suppliers = sorted(
        ({"counterparty_id": str(cid), "name": cps[cid].display_name, "kind": cps[cid].kind, "items": items}
         for cid, items in by_cp.items() if cid in cps), key=lambda s: s["name"].lower())

    st = stats(db)
    kinds = []
    for arm, s in sorted(st.items()):
        n = s.wins + s.losses
        if arm == TOP_ARM or n == 0:
            continue
        share = s.wins / n
        fold = n >= FOLD_AFTER and share < FOLD_BELOW and arm not in PINNED_KINDS
        kinds.append({"kind": arm, "label": kind_label(arm), "acted_on": s.wins, "turned_down": s.losses,
                      "decisions": n, "acted_share": round(share, 2), "less_useful": fold,
                      "sentence": f"You acted on {s.wins} of {n}. "
                                  + ("We show minor ones folded under “Less useful to you”." if fold else
                                     "We show them higher." if share >= 0.5 else "We show them a little lower.")})

    filled = kept = undone = helped = 0
    for learned, status in db.execute(select(Document.learned, Document.status)).all():
        if not learned:
            continue
        helped += 1
        for v in learned.values():
            filled += 1
            if v.get("undone"):
                undone += 1
            elif status == "approved":
                kept += 1
    top = st.get(TOP_ARM)
    top_n = (top.wins + top.losses) if top else 0
    all_n = sum(s.wins + s.losses for a, s in st.items() if a != TOP_ARM)
    all_w = sum(s.wins for a, s in st.items() if a != TOP_ARM)
    return {
        "suppliers": suppliers,
        "recommendations": kinds,
        "numbers": {
            "fields_filled": filled, "fields_kept": kept, "fields_undone": undone, "documents_helped": helped,
            "seconds_per_field": SECONDS_PER_FIELD, "minutes_saved": round(kept * SECONDS_PER_FIELD / 60, 1),
            "decisions": all_n, "acted_on": all_w, "acted_share": round(all_w / all_n, 2) if all_n else None,
            "top_decisions": top_n, "top_acted_on": top.wins if top else 0,
            "top_acted_share": round(top.wins / top_n, 2) if top_n else None,
        },
        "rules": {"learn_after": LEARN_AFTER, "fold_after": FOLD_AFTER, "fold_below": FOLD_BELOW},
        "assumptions": [(f"We count about {SECONDS_PER_FIELD} seconds for each value a person would otherwise "
                         "find on the document and type in.")],
        "never_learned": ["bank details", "contact details", "amounts"],
    }


# ── Reset ──────────────────────────────────────────────────────────────────


def reset(db: Session, business_id, actor: str, scope: str, counterparty_id: UUID | None = None,
          field: str | None = None, kind: str | None = None) -> dict:
    """Forget what we learned. Corrections are kept as history but no longer learned from."""
    now = datetime.now(UTC)
    forgotten = cleared = 0
    if scope in ("all", "supplier", "field"):
        q = update(Correction).where(Correction.forgotten_at.is_(None))
        if scope != "all":
            docs = select(Document.id).where(Document.counterparty_id == counterparty_id)
            q = q.where(or_(Correction.counterparty_id == counterparty_id, Correction.document_id.in_(docs)))
        if scope == "field":
            q = q.where(Correction.field.in_(SOURCE_FIELDS.get(field, (field,))))
        forgotten = db.execute(q.values(forgotten_at=now)).rowcount
    if scope in ("all", "kind"):
        q = select(LearningStat)
        if scope == "kind":
            q = q.where(LearningStat.arm == kind)
        for s in db.execute(q).scalars().all():
            db.delete(s)
            cleared += 1
    audit.record(db, business_id, actor, "learning_reset",
                 subject=f"counterparty:{counterparty_id}" if counterparty_id else None,
                 details={"scope": scope, "field": field, "kind": kind, "corrections_forgotten": forgotten,
                          "rankings_cleared": cleared})
    return {"corrections_forgotten": forgotten, "rankings_cleared": cleared}
