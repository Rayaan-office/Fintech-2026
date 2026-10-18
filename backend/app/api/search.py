"""Search everything in one business: customers, suppliers, invoices, bills, documents,
recommendations and approvals waiting for a person.

The search is sent in the request body (POST), so names people type never appear in addresses or
access logs, and we never write the search text to the activity log or the server log. Each result
links to an existing page by id only. The search runs in a read-only transaction that can see only
the caller's business.
"""

import re
from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints
from rapidfuzz import fuzz
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from ..db import read_only_session
from ..models import Action, Counterparty, Document, Recommendation, Record
from ..pipeline.counterparties import normalize
from ..privacy.detectors import detect
from ..security.http import limiter
from ..security.rbac import Perm
from .deps import Principal, require

router = APIRouter(prefix="/api", tags=["search"])

MIN_CHARS = 2
MAX_RESULTS = 20
PER_KIND = 8  # so one kind cannot crowd out the rest
KIND_ORDER = ("customer", "supplier", "invoice", "bill", "document", "recommendation", "approval")
SYMBOLS = {"GBP": "£", "EUR": "€", "USD": "$"}
# Never shown in a result, whatever a filename or summary contains
HIDDEN = {"CARD", "BANK_ACCOUNT", "SORT_CODE", "ROUTING_NUMBER", "EMAIL", "PHONE", "NI_NUMBER", "TAX_ID"}
_AMOUNT = re.compile(r"^[£$€]?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$")
FUZZY_MIN = 88


class SearchIn(BaseModel):
    q: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]


def _db(p: Principal = Depends(require(Perm.VIEW_ALL))) -> Iterator[Session]:
    with read_only_session(p.business_id) as db:
        yield db


def amount_minor(q: str) -> int | None:
    """'300', '£300', '300.00' and '1,800.00' are amounts; anything else is not."""
    m = _AMOUNT.match(q)
    if not m:
        return None
    pence = (m.group(2) or "0").ljust(2, "0")
    return int(m.group(1).replace(",", "")) * 100 + int(pence)


def _escape(q: str) -> str:
    """So % and _ are searched for as themselves, not as wildcards."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class _Terms:
    def __init__(self, q: str):
        e = _escape(q.lower())
        self.exact, self.prefix, self.word, self.anywhere = e, f"{e}%", f"% {e}%", f"%{e}%"

    def matches(self, col):
        return col.ilike(self.anywhere, escape="\\")

    def rank(self, col):
        """0 exact, 1 starts with it, 2 a word starts with it, 3 anywhere."""
        low = func.lower(col)
        return case((low.like(self.exact, escape="\\"), 0), (low.like(self.prefix, escape="\\"), 1),
                    (low.like(self.word, escape="\\"), 2), else_=3)


def money(minor: int, currency: str) -> str:
    sym = SYMBOLS.get((currency or "GBP").upper())
    return f"{sym}{minor / 100:,.2f}" if sym else f"{minor / 100:,.2f} {currency.upper()}"


def clean(label: str) -> str:
    """Plain words only: bank details, emails and phone numbers are taken out."""
    hits = [h for h in detect(label, people=False) if h.kind in HIDDEN]
    for h in sorted(hits, key=lambda h: h.start, reverse=True):
        label = label[:h.start] + "…" + label[h.end:]
    return " ".join(label.split())[:200]


def _hit(kind: str, id_, label: str, href: str, rank: int, order: int) -> dict:
    return {"id": str(id_), "kind": kind, "label": clean(label), "href": href, "_rank": rank, "_order": order}


class _Places:
    """Where to send someone for a supplier or customer: the newest recommendation about them that is
    still open, else their newest document, else the overview that lists them."""

    def __init__(self, db: Session):
        self.db = db
        self._seen: dict[UUID, str] = {}

    def for_party(self, cp_id: UUID, kind: str) -> str:
        if cp_id not in self._seen:
            self._seen[cp_id] = self._party(cp_id, kind)
        return self._seen[cp_id]

    def _party(self, cp_id: UUID, kind: str) -> str:
        rec = self.db.execute(select(Recommendation.id).where(
            Recommendation.counterparty_id == cp_id, Recommendation.status == "new")
            .order_by(Recommendation.updated_at.desc()).limit(1)).scalar()
        if rec:
            return f"/recommendations?open={rec}"
        doc = self.db.execute(select(Document.id).where(Document.counterparty_id == cp_id)
                              .order_by(Document.created_at.desc()).limit(1)).scalar()
        if doc:
            return f"/documents?open={doc}"
        return "/health?view=owed" if kind == "customer" else "/health?view=suppliers"

    def for_record(self, r: Record, doc_ok: bool) -> str:
        if r.document_id and doc_ok:
            return f"/documents?open={r.document_id}"
        if r.status == "open" and r.kind == "bill":
            return "/cash-flow"  # unpaid bills are on the forecast
        if r.status == "open" and r.kind == "invoice":
            return "/health?view=owed"
        if r.counterparty_id:
            return self.for_party(r.counterparty_id, "customer" if r.kind == "invoice" else "supplier")
        return "/health"


def _parties(db: Session, q: str, t: _Terms, places: _Places) -> list[dict]:
    rank = t.rank(Counterparty.display_name).label("rank")
    found = []
    for kind in ("customer", "supplier"):
        found += [(cp, r) for cp, r in db.execute(
            select(Counterparty, rank).where(Counterparty.kind == kind, t.matches(Counterparty.display_name))
            .order_by(rank, Counterparty.display_name).limit(PER_KIND)).all()]
    # A small typo still finds the supplier or customer ("acme suplies")
    norm = normalize(q)
    if len(norm) >= 4:
        seen = {cp.id for cp, _ in found}
        for cp in db.execute(select(Counterparty)).scalars():
            if cp.id not in seen and fuzz.partial_ratio(norm, cp.normalized_name) >= FUZZY_MIN:
                found.append((cp, 4))
    out = []
    for kind in ("customer", "supplier"):
        mine = sorted(((cp, r) for cp, r in found if cp.kind == kind), key=lambda x: (x[1], x[0].display_name))
        out += [_hit(kind, cp.id, cp.display_name, places.for_party(cp.id, kind), r, i)
                for i, (cp, r) in enumerate(mine[:PER_KIND])]
    return out


def _records(db: Session, q: str, t: _Terms, places: _Places) -> list[dict]:
    minor = amount_minor(q)
    ref = func.coalesce(Record.reference, "")
    rank = t.rank(ref)
    if minor is not None:
        rank = case((Record.amount_minor == minor, 0), else_=rank)
        hit = or_(t.matches(ref), Record.amount_minor == minor)
    else:
        hit = t.matches(ref)
    rank = rank.label("rank")
    out = []
    for kind in ("invoice", "bill"):
        rows = db.execute(select(Record, Counterparty.display_name, rank)
                          .outerjoin(Counterparty, Counterparty.id == Record.counterparty_id)
                          .where(Record.kind == kind, Record.status != "void", hit)
                          .order_by(rank, Record.date.desc()).limit(PER_KIND)).all()
        docs = {d for d in db.execute(select(Document.id).where(
            Document.id.in_({r.document_id for r, *_ in rows if r.document_id}))).scalars()}
        for i, (r, name, rk) in enumerate(rows):
            parts = [f"{kind.title()} {r.reference or ''}".strip(), name, money(r.amount_minor, r.currency)]
            if r.status == "paid":
                parts.append("paid")
            out.append(_hit(kind, r.id, " · ".join(p for p in parts if p), places.for_record(r, r.document_id in docs),
                            rk, i))
    return out


def _documents(db: Session, t: _Terms) -> list[dict]:
    party = func.coalesce(Counterparty.display_name, Document.fields["counterparty_name"].astext, "")
    rank = func.least(t.rank(Document.filename), t.rank(party)).label("rank")
    rows = db.execute(select(Document, party, rank)
                      .outerjoin(Counterparty, Counterparty.id == Document.counterparty_id)
                      .where(or_(t.matches(Document.filename), t.matches(party)))
                      .order_by(rank, Document.created_at.desc()).limit(PER_KIND)).all()
    return [_hit("document", d.id, " · ".join(x for x in (d.filename, name) if x), f"/documents?open={d.id}", rk, i)
            for i, (d, name, rk) in enumerate(rows)]


def _recommendations(db: Session, t: _Terms) -> list[dict]:
    # Only open ones: those are the ones the recommendations page lists and can open
    rank = t.rank(Recommendation.title).label("rank")
    rows = db.execute(select(Recommendation.id, Recommendation.title, rank)
                      .where(Recommendation.status == "new", t.matches(Recommendation.title))
                      .order_by(rank, Recommendation.score.desc()).limit(PER_KIND)).all()
    return [_hit("recommendation", rid, title, f"/recommendations?open={rid}", rk, i)
            for i, (rid, title, rk) in enumerate(rows)]


def _approvals(db: Session, t: _Terms) -> list[dict]:
    rank = t.rank(Action.summary).label("rank")
    rows = db.execute(select(Action.id, Action.summary, rank)
                      .where(Action.status == "pending", t.matches(Action.summary))
                      .order_by(rank, Action.level.desc(), Action.created_at).limit(PER_KIND)).all()
    return [_hit("approval", aid, summary, f"/inbox?action={aid}", rk, i) for i, (aid, summary, rk) in enumerate(rows)]


def search(db: Session, q: str) -> list[dict]:
    q = " ".join(q.split())
    if len(q) < MIN_CHARS:
        return []
    t = _Terms(q)
    places = _Places(db)
    hits = (_parties(db, q, t, places) + _records(db, q, t, places) + _documents(db, t)
            + _recommendations(db, t) + _approvals(db, t))
    # Best matches first; within the same strength, grouped by kind in a fixed order
    hits.sort(key=lambda h: (h["_rank"], KIND_ORDER.index(h["kind"]), h["_order"]))
    return [{k: v for k, v in h.items() if not k.startswith("_")} for h in hits[:MAX_RESULTS]]


@router.post("/search")
def search_endpoint(body: SearchIn, p: Principal = Depends(require(Perm.VIEW_ALL)), db: Session = Depends(_db)):
    limiter.check(f"search:{p.user_id}", 60, 60)
    return {"results": search(db, body.q)}
