"""Search over document text for the assistant (docs/ALGORITHMS.md, section 12).

We search the text the AI was shown when the document was read (placeholders only), using the
full-text index on documents.search_tsv. Each passage is cleaned before it goes anywhere:

  1. the document's own placeholders ([PERSON_1], [BANK_ACCOUNT_2]) become neutral tags such as
     [hidden person], so they can never be mistaken for, or restored as, a placeholder in the chat;
  2. anything our detectors still find becomes a neutral tag too (patterns first, then, once
     supplier and customer names are the chat's placeholders, people's names);
  3. after the passage is cut out, the detectors run once more over it.

The assistant then runs its usual redaction over all the facts, and the gateway's final scan
still checks the exact text sent. Retrieval sits behind find(), so a semantic search could
replace it later without changing what happens to a passage.
"""

import re
from dataclasses import dataclass

from sqlalchemy import func, literal_column, select
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Session

from ..models import Document
from ..privacy.detectors import PLACEHOLDER_RE, detect

TOP = 3
PASSAGE_CHARS = 300
_TSV = literal_column("documents.search_tsv", TSVECTOR)
MARK = ("<mark>", "</mark>")
# The whole text with every matching word marked; we pick the windows ourselves (see _excerpt)
_HEADLINE = f'HighlightAll=true, StartSel="{MARK[0]}", StopSel="{MARK[1]}"'
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'-]*")

TAGS = {
    "PERSON": "[hidden person]", "BANK_ACCOUNT": "[hidden bank account]", "SORT_CODE": "[hidden sort code]",
    "CARD": "[hidden card]", "ROUTING_NUMBER": "[hidden bank number]", "TAX_ID": "[hidden tax number]",
    "NI_NUMBER": "[hidden tax number]", "COMPANY_ID": "[hidden company number]", "EMAIL": "[hidden email]",
    "PHONE": "[hidden phone]", "WEB_LINK": "[hidden link]", "IP_ADDRESS": "[hidden link]",
    "POSTCODE": "[hidden address]", "ADDRESS": "[hidden address]",
}


def tag(kind: str) -> str:
    return TAGS.get(kind, "[hidden detail]")


def neutral(text: str, keep: tuple[str, ...] = ()) -> str:
    """Placeholders as neutral tags, which never match PLACEHOLDER_RE. `keep` names kinds to leave as
    they are, such as SUPPLIER and CUSTOMER, whose numbering is the same in every message."""
    def sub(m):
        kind = m.group()[1:-1].rsplit("_", 1)[0]
        return m.group() if kind in keep else tag(kind)

    return PLACEHOLDER_RE.sub(sub, text or "")


def hide_left(text: str, people: bool = True) -> str:
    """Anything the detectors still find, as a neutral tag (no numbering, nothing to restore)."""
    out, pos = [], 0
    for h in detect(text, people=people):
        out += [text[pos:h.start], tag(h.kind)]
        pos = h.end
    return "".join(out) + text[pos:]


def search_words(words: str | None) -> str:
    """The AI's search words without placeholders, which never appear in stored text."""
    return " ".join(_WORD.findall(PLACEHOLDER_RE.sub(" ", words or "")))[:200]


@dataclass
class Passage:
    document: Document
    text: str  # cleaned, with the chat's placeholders for suppliers and customers


def _cut(text: str, a: int, b: int) -> tuple[int, int]:
    """Widen or narrow a window to whole words, never splitting a [placeholder] or [hidden tag]."""
    if a > 0:
        a = text.find(" ", a) + 1 or a
        o = text.rfind("[", 0, a)
        if o != -1 and text.find("]", o) >= a:
            a = o
    if b < len(text):
        b = max(text.rfind(" ", a, b), a + 1)
        o = text.rfind("[", a, b)
        if o != -1 and not 0 <= text.find("]", o) < b:
            b = o
    return a, b


def _excerpt(marked: str) -> str:
    """Up to two windows around the words Postgres matched, about PASSAGE_CHARS in all."""
    text, hits = "", []
    for part in re.split(f"({re.escape(MARK[0])}|{re.escape(MARK[1])})", marked):
        if part == MARK[0]:
            hits.append(len(text))
        elif part != MARK[1]:
            text += part
    picked: list[int] = []
    for h in hits:
        if all(abs(h - p) > PASSAGE_CHARS // 2 for p in picked):
            picked.append(h)
        if len(picked) == 2:
            break
    picked = picked or [0]
    size = PASSAGE_CHARS // len(picked)
    windows = [_cut(text, max(0, h - size // 3), h + size - size // 3) for h in picked]
    parts = [" ".join(text[a:b].split()) for a, b in windows]
    return " … ".join(p for p in parts if p)


def find(db: Session, words: str, names, party_id=None) -> list[Passage]:
    """The best TOP documents for the words, each with one cleaned passage."""
    words = search_words(words)
    if not words:
        return []
    docs: list[Document] = []
    # Every word first; if no document has them all, any of them
    for query in (words, " or ".join(words.split())):
        tsq = func.websearch_to_tsquery("english", query)
        q = select(Document).where(Document.redacted_text.is_not(None), _TSV.bool_op("@@")(tsq))
        if party_id:
            q = q.where(Document.counterparty_id == party_id)
        docs = db.execute(q.order_by(func.ts_rank(_TSV, tsq).desc(), Document.created_at.desc())
                          .limit(TOP)).scalars().all()
        if docs or " " not in words:
            break
    out = []
    for d in docs:
        # On the whole text first, so a window never cuts a name or detail in half. Patterns go before
        # supplier names, so an email such as jo@acme.example is hidden whole, not as jo@[SUPPLIER_1]...
        full = hide_left(neutral(d.redacted_text), people=False)
        full = hide_left(names.hide(full)).replace(MARK[0], " ").replace(MARK[1], " ")
        marked = db.execute(select(func.ts_headline("english", full, tsq, _HEADLINE))).scalar() or full
        out.append(Passage(d, hide_left(_excerpt(marked))))
    return out
