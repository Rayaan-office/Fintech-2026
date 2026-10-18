"""How a payment was made, from what the bank or payment platform tells us (docs/ALGORITHMS.md,
"Getting paid").

  card                    a card payment through the payment platform, or a platform payout
  international_transfer  a bank payment in another currency, or one whose text says SWIFT, INTL, FX…
  cash                    cash paid in at a branch or counter
  bank_transfer           any other bank payment (Faster Payments, BACS, standing order…)
  unknown                 nothing to go on

Records saved before we kept the method get it from their text the same way.
"""

import re

from ..models import Record

METHODS = ("card", "bank_transfer", "international_transfer", "cash", "unknown")
LABELS = {"card": "Card", "bank_transfer": "Bank transfer", "international_transfer": "International transfer",
          "cash": "Cash", "unknown": "Not known"}
PLATFORMS = ("stripe", "sumup", "square", "paypal", "zettle", "worldpay")
_INTERNATIONAL = re.compile(r"\b(swift|intl|international|fx|foreign|sepa|iban|bic|telegraphic|tt)\b", re.I)
_CASH = re.compile(r"\b(cash|csh|counter credit)\b", re.I)
_CARD = re.compile(r"\b(card|pos|contactless|visa|mastercard|amex)\b", re.I)
# Stripe payment method types that are bank payments rather than cards
_STRIPE_BANK = ("bacs_debit", "sepa_debit", "customer_balance", "pay_by_bank", "bank_transfer")


def from_bank(text: str | None, currency: str, account_currency: str, channel: str | None = None) -> str:
    """A bank line's method, from its currency, its text and the bank's payment channel."""
    t = text or ""
    if currency.upper() != account_currency.upper() or _INTERNATIONAL.search(t):
        return "international_transfer"
    if any(p in t.lower() for p in PLATFORMS):
        return "card"  # card sales paid out by the payment platform
    if _CASH.search(t):
        return "cash"
    if _CARD.search(t) or channel == "in store":
        return "card"
    return "bank_transfer"


def from_stripe(details: dict | None) -> tuple[str, str | None]:
    """A Stripe charge's method and, for a card, the country that issued it."""
    d = details if isinstance(details, dict) else {}
    kind = str(d.get("type") or "card")
    if kind in _STRIPE_BANK:
        return "bank_transfer", None
    card = d.get("card") if isinstance(d.get("card"), dict) else {}
    country = card.get("country")
    return "card", country if isinstance(country, str) and len(country) == 2 else None


def of(r: Record, account_currency: str = "GBP") -> str:
    """The method we keep, or the one its text suggests for older records."""
    if r.method in METHODS:
        return r.method
    if r.source == "stripe" and r.kind == "payment_in":
        return "card"
    if r.kind == "bank_txn":
        return from_bank(r.description, r.currency, account_currency)
    return "unknown"
