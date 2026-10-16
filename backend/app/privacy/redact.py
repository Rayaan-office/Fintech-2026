"""Replace sensitive details with placeholders before any text reaches the AI.

    redacted = redact(text)                 # placeholders such as [BANK_ACCOUNT_1]
    final_scan(redacted.text)               # raises PrivacyBlock if anything is left
    store_in_vault(business_id, redacted)   # real values, encrypted, separate DB account
    restore(value, mapping)                 # put real values back after the AI has finished

The same value always gets the same placeholder within one piece of text, so the AI can
still say "the account on line 3 matches the one on line 9".
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import text as sql

from ..db import vault_session
from ..security.crypto import fingerprint, vault
from .detectors import PLACEHOLDER_RE, Hit, detect


class PrivacyBlock(Exception):
    """Something sensitive is still in the text. Nothing is sent; a person takes over."""

    def __init__(self, kinds: list[str]):
        super().__init__("sensitive details remain: " + ", ".join(sorted(set(kinds))))
        self.kinds = sorted(set(kinds))


@dataclass
class Redacted:
    text: str
    # placeholder -> (kind, real value). Real values live only in memory until stored in the vault.
    values: dict[str, tuple[str, str]] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)

    def summary(self) -> dict[str, int]:
        """How many of each kind were hidden; safe to log."""
        return dict(self.counts)


def _norm(kind: str, value: str) -> str:
    v = value.strip()
    if kind in {"BANK_ACCOUNT", "SORT_CODE", "CARD", "PHONE", "ROUTING_NUMBER", "TAX_ID", "NI_NUMBER"}:
        return "".join(ch for ch in v if ch.isalnum()).upper()
    return " ".join(v.lower().split())


def redact(text: str, existing: Redacted | None = None, people: bool = True) -> Redacted:
    """Replace every detected detail. Pass `existing` to keep numbering across several texts."""
    out = existing or Redacted(text="")
    by_value = {(k, _norm(k, v)): ph for ph, (k, v) in out.values.items()}
    hits: list[Hit] = detect(text, people=people)
    parts, pos = [], 0
    for h in hits:
        key = (h.kind, _norm(h.kind, h.value))
        ph = by_value.get(key)
        if not ph:
            out.counts[h.kind] = out.counts.get(h.kind, 0) + 1
            ph = f"[{h.kind}_{out.counts[h.kind]}]"
            out.values[ph] = (h.kind, h.value)
            by_value[key] = ph
        parts.append(text[pos:h.start])
        parts.append(ph)
        pos = h.end
    parts.append(text[pos:])
    out.text = "".join(parts)
    return out


def final_scan(text: str) -> None:
    """Second, independent pass over the exact text about to be sent. Fails closed."""
    try:
        left = detect(text, people=True)
    except Exception as exc:  # if the scan itself breaks, nothing is sent
        raise PrivacyBlock(["scan_error"]) from exc
    if left:
        raise PrivacyBlock([h.kind for h in left])


def store_in_vault(business_id, redacted: Redacted) -> dict[str, str]:
    """Encrypt each real value into the vault. Returns placeholder -> vault id."""
    mapping: dict[str, str] = {}
    if not redacted.values:
        return mapping
    with vault_session(business_id) as db:
        for ph, (kind, value) in redacted.values.items():
            vid = uuid.uuid4()
            db.execute(
                sql("INSERT INTO vault.pii_values (id, business_id, kind, ciphertext, fingerprint) "
                    "VALUES (:id, :b, :k, :c, :f)"),
                {"id": vid, "b": str(business_id), "k": kind, "c": vault.seal_str(value),
                 "f": fingerprint(_norm(kind, value), kind)},
            )
            mapping[ph] = str(vid)
    return mapping


def store_value(business_id, kind: str, value: str) -> str:
    """Encrypt one real value from a connected tool (e.g. a customer's email) into the vault. Returns its id."""
    vid = uuid.uuid4()
    with vault_session(business_id) as db:
        db.execute(
            sql("INSERT INTO vault.pii_values (id, business_id, kind, ciphertext, fingerprint) "
                "VALUES (:id, :b, :k, :c, :f)"),
            {"id": vid, "b": str(business_id), "k": kind, "c": vault.seal_str(value),
             "f": fingerprint(_norm(kind, value), kind)},
        )
    return str(vid)


def vault_values(business_id, vault_ids: list[str]) -> dict[str, str]:
    """Read real values back. Only server code that needs them (restoring a form, sending an
    approved email) calls this; it is never exposed to the AI."""
    if not vault_ids:
        return {}
    with vault_session(business_id) as db:
        rows = db.execute(
            sql("SELECT id::text, ciphertext FROM vault.pii_values WHERE id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": vault_ids},
        ).all()
    return {r[0]: vault.open_str(r[1]) for r in rows}


def restore(value, placeholder_to_real: dict[str, str]):
    """Put real values back into an AI answer (strings, lists and dicts)."""
    if isinstance(value, str):
        return PLACEHOLDER_RE.sub(lambda m: placeholder_to_real.get(m.group(), m.group()), value)
    if isinstance(value, list):
        return [restore(v, placeholder_to_real) for v in value]
    if isinstance(value, dict):
        return {k: restore(v, placeholder_to_real) for k, v in value.items()}
    return value


def value_fingerprint(kind: str, value: str) -> str:
    return fingerprint(_norm(kind, value), kind)


def mask(kind: str, value: str) -> str:
    """Short display form for people with permission, e.g. ••••6819."""
    v = _norm(kind, value)
    if kind in {"BANK_ACCOUNT", "CARD", "SORT_CODE", "ROUTING_NUMBER"}:
        return "••••" + v[-4:]
    if kind == "EMAIL" and "@" in value:
        name, dom = value.split("@", 1)
        return name[:1] + "•••@" + dom
    if kind == "PHONE":
        return "•••• " + v[-3:]
    return value
