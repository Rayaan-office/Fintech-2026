"""Detectors for sensitive details.

Pattern-based detectors use checksums where one exists (cards: Luhn; IBAN: mod-97;
UK VAT: mod-97 variant), so ordinary numbers such as totals or invoice numbers are
not mistaken for bank details. Presidio's language model adds people's names.
"""

import re
from dataclasses import dataclass
from functools import lru_cache

import phonenumbers
from stdnum import iban as std_iban
from stdnum import luhn
from stdnum.gb import vat as gb_vat


@dataclass(frozen=True)
class Hit:
    start: int
    end: int
    kind: str  # placeholder label, e.g. BANK_ACCOUNT
    value: str
    score: float = 1.0


PLACEHOLDER_RE = re.compile(r"\[[A-Z_]+_\d+\]")

# Placeholder label for each detector
LABELS = {
    "card": "CARD",
    "iban": "BANK_ACCOUNT",
    "account": "BANK_ACCOUNT",
    "sort_code": "SORT_CODE",
    "routing": "ROUTING_NUMBER",
    "vat": "TAX_ID",
    "ni": "NI_NUMBER",
    "utr": "TAX_ID",
    "company_no": "COMPANY_ID",
    "email": "EMAIL",
    "phone": "PHONE",
    "url": "WEB_LINK",
    "ip": "IP_ADDRESS",
    "postcode": "POSTCODE",
    "street": "ADDRESS",
    "person": "PERSON",
}

_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b")
_SORT = re.compile(r"(?<![\d-])\d{2}[- ]\d{2}[- ]\d{2}(?![\d-])")
_ACCOUNT_CTX = re.compile(r"(?i)\b(?:account(?:\s*(?:no|number|num))?|acc(?:ount)?\.?\s*no|a/c)\b[\s.:#-]*")
_DIGITS_8 = re.compile(r"(?<!\d)\d{8}(?!\d)")
_ROUTING_CTX = re.compile(r"(?i)\b(?:routing|aba|ach)\b[^\d\n]{0,20}(\d{9})(?!\d)")
_VAT = re.compile(r"\bGB ?(\d{3} ?\d{4} ?\d{2}(?: ?\d{3})?)\b")
# Broader than the official letter rules on purpose: over-hiding is safer than missing one
_NI = re.compile(r"\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b")
_UTR = re.compile(r"(?i)\b(?:UTR|unique taxpayer reference)\b[^\d\n]{0,20}(\d{5} ?\d{5})(?!\d)")
_COMPANY = re.compile(r"(?i)\bcompany\s*(?:no|number|reg(?:istration)?(?:\s*no)?)\b[.:\s#]*((?:SC|NI|OC)?\d{6,8})\b")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_URL = re.compile(r"\b(?:https?://|www\.)[^\s<>\"')\]]+", re.I)
_IP = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
_POSTCODE = re.compile(r"\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b")
_STREET = re.compile(
    r"\b\d{1,4}[A-Za-z]?,?\s+(?:[A-Z][a-z']+\s){1,3}"
    r"(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Close|Drive|Dr|Way|Place|Pl|Court|Ct|Crescent|Terrace|Gardens|"
    r"Square|Row|Mews|Hill|Park|Grove|Walk|Parade|Green|Yard|Wharf|Quay|Boulevard|Blvd)\b\.?"
)


def _overlaps(a: Hit, b: Hit) -> bool:
    return a.start < b.end and b.start < a.end


def _find_cards(text: str) -> list[Hit]:
    out = []
    for m in _CARD.finditer(text):
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 19 and luhn.is_valid(digits):
            out.append(Hit(m.start(), m.end(), "CARD", m.group()))
    return out


def _find_ibans(text: str) -> list[Hit]:
    out = []
    for m in _IBAN.finditer(text):
        if std_iban.is_valid(m.group()):
            out.append(Hit(m.start(), m.end(), "BANK_ACCOUNT", m.group()))
    return out


def _find_accounts(text: str) -> list[Hit]:
    """UK account numbers: 8 digits shortly after the word 'account' (or next to a sort code)."""
    out = []
    for ctx in _ACCOUNT_CTX.finditer(text):
        window = text[ctx.end(): ctx.end() + 40]
        m = _DIGITS_8.search(window)
        if m:
            s = ctx.end() + m.start()
            out.append(Hit(s, s + 8, "BANK_ACCOUNT", m.group()))
    for sm in _SORT.finditer(text):
        m = _DIGITS_8.search(text[sm.end(): sm.end() + 25])
        if m:
            s = sm.end() + m.start()
            out.append(Hit(s, s + 8, "BANK_ACCOUNT", m.group()))
    return out


def _aba_valid(d: str) -> bool:
    w = [3, 7, 1] * 3
    return sum(int(c) * k for c, k in zip(d, w)) % 10 == 0


def _find_routing(text: str) -> list[Hit]:
    return [Hit(m.start(1), m.end(1), "ROUTING_NUMBER", m.group(1))
            for m in _ROUTING_CTX.finditer(text) if _aba_valid(m.group(1))]


def _find_vat(text: str) -> list[Hit]:
    out = []
    for m in _VAT.finditer(text):
        if gb_vat.is_valid("GB" + m.group(1).replace(" ", "")):
            out.append(Hit(m.start(), m.end(), "TAX_ID", m.group()))
    return out


def _find_phones(text: str) -> list[Hit]:
    """Phone numbers, including test ranges: written with + or a leading 0, with 10+ digits."""
    out = []
    for region in ("GB", "US"):
        for m in phonenumbers.PhoneNumberMatcher(text, region, leniency=phonenumbers.Leniency.POSSIBLE):
            raw = m.raw_string
            digits = sum(c.isdigit() for c in raw)
            if raw.lstrip("(").startswith(("+", "0")) and 10 <= digits <= 15 and "/" not in raw:
                out.append(Hit(m.start, m.end, "PHONE", raw))
    return out


def _simple(regex: re.Pattern, kind: str, group: int = 0):
    def find(text: str) -> list[Hit]:
        return [Hit(m.start(group), m.end(group), kind, m.group(group)) for m in regex.finditer(text)]

    return find


PATTERN_DETECTORS = [
    _find_cards,
    _find_ibans,
    _find_accounts,
    _simple(_SORT, "SORT_CODE"),
    _find_routing,
    _find_vat,
    _simple(_NI, "NI_NUMBER"),
    _simple(_UTR, "TAX_ID", 1),
    _simple(_COMPANY, "COMPANY_ID", 1),
    _simple(_EMAIL, "EMAIL"),
    _simple(_URL, "WEB_LINK"),
    _simple(_IP, "IP_ADDRESS"),
    _find_phones,
    _simple(_POSTCODE, "POSTCODE"),
    _simple(_STREET, "ADDRESS"),
]


@lru_cache(maxsize=1)
def _presidio():
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    provider = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}],
    })
    return AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])


_TITLE = re.compile(r"(?i)\b(?:mr|mrs|ms|miss|dr|prof)\.?\s+$")


def find_people(text: str, threshold: float = 0.7) -> list[Hit]:
    results = _presidio().analyze(text, language="en", entities=["PERSON"], score_threshold=threshold)
    out = []
    for r in results:
        value = text[r.start:r.end]
        # Ignore our own placeholders, and single words (such as "Bill") unless they follow a title
        if PLACEHOLDER_RE.search(value) or len(value.strip()) < 3:
            continue
        if len(value.split()) < 2 and not _TITLE.search(text[max(0, r.start - 6):r.start]):
            continue
        out.append(Hit(r.start, r.end, "PERSON", value, r.score))
    return out


def detect(text: str, people: bool = True) -> list[Hit]:
    """All sensitive spans, longest first where they overlap."""
    hits: list[Hit] = []
    for d in PATTERN_DETECTORS:
        hits.extend(d(text))
    if people:
        hits.extend(find_people(text))
    # Drop anything inside an existing placeholder
    spans = [(m.start(), m.end()) for m in PLACEHOLDER_RE.finditer(text)]
    hits = [h for h in hits if not any(s <= h.start and h.end <= e for s, e in spans)]
    hits.sort(key=lambda h: (-(h.end - h.start), h.start))
    chosen: list[Hit] = []
    for h in hits:
        if not any(_overlaps(h, c) for c in chosen):
            chosen.append(h)
    return sorted(chosen, key=lambda h: h.start)
