"""The AI turns facts our code found into plain words, and our code checks every figure.

    names = Names(db)                       # suppliers and customers as [SUPPLIER_1], [CUSTOMER_2]
    w = write(business_id, "recommendation", INSTRUCTIONS, facts, names, fallback=("Title", "Body"))

- The facts go to the AI as short labelled lines, already written as money, percentages and
  dates, with every name replaced by a placeholder. A final privacy pass hides anything else.
- Every number in the answer must appear in the facts (or be one of them rounded); every
  placeholder must be one we sent. One rewrite is allowed, told exactly what was wrong.
- If the AI is paused, unavailable or still wrong, the plain template is used instead.
"""

import hashlib
import json
import logging
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai import gateway
from ..models import Business, Counterparty
from ..privacy.detectors import PLACEHOLDER_RE
from ..privacy.redact import PrivacyBlock, Redacted, redact, restore

log = logging.getLogger("copilot.wording")

_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
STYLE = (
    "Write for the owner of a small business, in plain British English. Be short and specific. "
    "Use only the facts given: copy money, percentages and dates exactly as written there, and never "
    "work out new figures. Refer to suppliers and customers only by their placeholders, such as "
    "[SUPPLIER_1]. Never give personal financial advice."
)


_COMMON = {"the", "best", "first", "general", "green", "great", "north", "south", "east", "west", "city",
           "town", "national", "royal", "united", "british", "london", "your", "our", "new", "global",
           "station", "corner", "bright", "golden", "central", "local", "quick", "fast"}


class Names:
    """Stable placeholders for one business's suppliers and customers.

    The numbering follows the order they were first recorded, so the same customer keeps the same
    placeholder in every message of a chat."""

    def __init__(self, db: Session):
        rows = db.execute(select(Counterparty).order_by(Counterparty.kind, Counterparty.created_at,
                                                        Counterparty.id)).scalars().all()
        self.by_id: dict = {}
        self.real: dict[str, str] = {}
        count = {"supplier": 0, "customer": 0}
        for c in rows:
            count[c.kind] = count.get(c.kind, 0) + 1
            ph = f"[{c.kind.upper()}_{count[c.kind]}]"
            self.by_id[c.id] = ph
            self.real[ph] = c.display_name
        self.kind = {c.id: c.kind for c in rows}
        self.ids = {ph: cid for cid, ph in self.by_id.items()}
        # Longest names first, so "Acme Supplies Ltd" wins over "Acme"
        self._find = sorted(((c.display_name, self.by_id[c.id]) for c in rows if len(c.display_name) >= 3),
                            key=lambda x: -len(x[0]))
        # People say "Acme" for "Acme Supplies Ltd": a first word that is capitalised and 4 letters or
        # more is matched too (case-sensitive, whole word)
        first: dict[str, list] = {}
        for c in rows:
            w = (c.display_name.split() or [""])[0].strip(",.&")
            if len(w) >= 4 and w[:1].isupper() and w.lower() not in _COMMON:
                first.setdefault(w, []).append(self.by_id[c.id])
        # A word shared by two or three ("Acme Supplies Ltd" and "Acme Supply Company") becomes
        # "[SUPPLIER_1] or [SUPPLIER_2]", so the assistant can look at both or ask which
        self._first = sorted(((w, " or ".join(phs)) for w, phs in first.items() if len(phs) <= 3),
                             key=lambda x: -len(x[0]))

    def of(self, counterparty_id) -> str:
        return self.by_id.get(counterparty_id, "")

    def hide(self, text: str) -> str:
        """Replace every known supplier or customer name in free text (e.g. a question)."""
        for name, ph in self._find:
            text = re.sub(rf"(?i)(?<!\w){re.escape(name)}(?!\w)", ph, text)
            short = re.sub(r"(?i)\s+(ltd|limited|plc|llp|co)\.?$", "", name)
            if short != name and len(short) >= 4:
                text = re.sub(rf"(?i)(?<!\w){re.escape(short)}(?!\w)", ph, text)
        for word, ph in getattr(self, "_first", []):
            text = re.sub(rf"(?<![\w\[]){re.escape(word)}(?![\w\]])", ph, text)
            text = re.sub(rf"(?<![\w\[]){re.escape(word.upper())}(?![\w\]])", ph, text)
        return text


def facts_text(facts: dict | list, indent: str = "") -> str:
    """Facts as labelled lines: 'price_now: £53.10'."""
    lines = []
    items = facts.items() if isinstance(facts, dict) else enumerate(facts, 1)
    for k, v in items:
        if isinstance(v, (dict, list)):
            lines.append(f"{indent}{k}:")
            lines.append(facts_text(v, indent + "  "))
        elif v is not None and v != "":
            lines.append(f"{indent}{k}: {v}")
    return "\n".join(x for x in lines if x)


def _value(token: str) -> Decimal | None:
    try:
        return Decimal(token.replace(",", ""))
    except InvalidOperation:
        return None


def _tokens(text: str):
    """(kind, token, value) for each number: money after £, a percentage before %, or plain."""
    text = PLACEHOLDER_RE.sub(" ", text or "")
    for m in _NUMBER.finditer(text):
        v = _value(m.group())
        if v is None:
            continue
        before, after = text[max(0, m.start() - 2):m.start()], text[m.end():m.end() + 9].lower()
        kind = "money" if "£" in before else "pct" if after.startswith(("%", " %", " per cent", " percent")) \
            else "plain"
        yield kind, m.group(), v


def _variants(v: Decimal) -> set[Decimal]:
    return {v, v.quantize(Decimal(1)), v.quantize(Decimal("0.1"))}


def allowed_numbers(*texts: str) -> dict[str, set[Decimal]]:
    """The figures in the facts. Money may only be money from the facts and a percentage only a
    percentage from the facts (each also rounded to a whole number or one decimal place); any
    other number must appear somewhere in the facts."""
    out: dict[str, set[Decimal]] = {"money": set(), "pct": set(), "plain": set()}
    for t in texts:
        for kind, _, v in _tokens(t):
            out[kind] |= _variants(v)
            out["plain"] |= _variants(v)
    return out


def problems(text: str, allowed: dict[str, set[Decimal]], placeholders: set[str]) -> list[str]:
    """What is wrong with an AI text: figures not in the facts, placeholders we never sent."""
    out = []
    for ph in set(PLACEHOLDER_RE.findall(text)) - placeholders:
        out.append(f"{ph} is not one of the names given")
    for kind, tok, v in _tokens(text):
        if v not in allowed[kind]:
            what = {"money": f"£{tok}", "pct": f"{tok}%", "plain": tok}[kind]
            out.append(f"{what} does not appear in the facts")
    return sorted(set(out))


class Wording(BaseModel):
    title: str = Field(description="One short line, at most 90 characters")
    body: str = Field(description="Two or three short sentences")


@dataclass
class Written:
    title: str
    body: str
    ai_written: bool
    ai_saw: str | None = None  # exactly what was sent, placeholders only
    problems: list[str] = field(default_factory=list)
    model: str | None = None


def ai_paused(db: Session, business_id) -> bool:
    biz = db.get(Business, business_id)
    return bool(biz and biz.ai_paused)


def prepare(facts: dict | list, names: Names, extra: Redacted | None = None) -> tuple[str, dict[str, str]]:
    """The facts text exactly as the AI will see it, and how to put the real values back."""
    text = names.hide(facts_text(facts))
    r = redact(text, existing=extra, people=True)
    back = {**names.real, **{ph: v for ph, (_, v) in r.values.items()}}
    return r.text, back


def write(business_id, purpose: str, instructions: str, facts: dict | list, names: Names,
          fallback: tuple[str, str], schema: type[BaseModel] = Wording, paused: bool = False,
          extra_allowed: str = "") -> Written:
    """Ask the AI to word the facts; check every figure; fall back to the template."""
    if paused:
        return Written(*fallback, ai_written=False)
    sent, back = prepare(facts, names)
    allowed = allowed_numbers(sent, extra_allowed)
    known = set(PLACEHOLDER_RE.findall(sent))
    context = ""
    for attempt in (1, 2):
        try:
            res = gateway.complete_json(business_id, purpose, f"{instructions}\n\n{STYLE}", sent, schema,
                                        context=context, max_tokens=1000)
        except (gateway.AIError, PrivacyBlock) as exc:
            log.info("wording fell back to the template (%s): %s", purpose, type(exc).__name__)
            return Written(*fallback, ai_written=False, ai_saw=sent)
        data = res.data.model_dump()
        wrong = problems(" ".join(str(v) for v in data.values()), allowed, known)
        if not wrong:
            data = restore(data, back)
            return Written(str(data.get("title", ""))[:300] or fallback[0], str(data.get("body", "")) or fallback[1],
                           ai_written=True, ai_saw=res.sent_text, model=res.model)
        context = ("Your previous answer was rejected by our fact check: " + "; ".join(wrong)
                   + ". Write it again using only the figures and names in the facts.")
        log.info("wording failed the fact check (%s, attempt %s): %s", purpose, attempt, wrong)
    return Written(*fallback, ai_written=False, ai_saw=sent, problems=wrong)


# Same facts, same words: explanations shown on every page load are written once
_cache: OrderedDict[str, Written] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_SIZE = 256


def cached_write(business_id, purpose: str, instructions: str, facts: dict | list, names: Names,
                 fallback: tuple[str, str], paused: bool = False) -> Written:
    key = hashlib.sha256(json.dumps([str(business_id), purpose, facts, sorted(names.real.items()), paused],
                                    sort_keys=True, default=str).encode()).hexdigest()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    w = write(business_id, purpose, instructions, facts, names, fallback, paused=paused)
    if w.ai_written or paused:  # don't remember a fallback caused by a passing outage
        with _cache_lock:
            _cache[key] = w
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    return w


def money(minor: float) -> str:
    sign = "-" if minor < 0 else ""
    return f"{sign}£{abs(minor) / 100:,.2f}"


def day(d) -> str:
    return f"{d.day} {d:%B %Y}"
