"""Card payment links for payment reminders: Stripe sandbox only.

A link is made only while an approved reminder is being sent, never before. It uses its own
restricted key (STRIPE_LINKS_KEY, rk_test_… with write access to Products, Prices and Payment
Links); the connector's read-only key can't make anything. Each invoice gets one link for its
amount, reused by later reminders, and the request carries an idempotency key, so a retry
returns the same link instead of a second one. An invoice from Stripe uses Stripe's own page.
"""

from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Record, Reminder
from . import outbound
from .stripe_conn import API, API_VERSION, StripeError

LINK_HOSTS = ("buy.stripe.com", "invoice.stripe.com")


def _raw() -> str:
    s = get_settings()
    return s.stripe_links_key.get_secret_value().strip() if s.stripe_links_key else ""


def _key() -> str | None:
    """The links key. Only a sandbox restricted key (rk_test_…) is ever used: any other key is
    ignored, and reminders then go out without a link."""
    key = _raw()
    return key if key.startswith("rk_test_") else None


def configured() -> bool:
    return _key() is not None


def problem() -> str | None:
    """Why a key that was set isn't used, in plain words."""
    if _raw() and not configured():
        return "The payment link key isn't a sandbox restricted key (rk_test_…), so we don't use it."
    return None


def _post(key: str, path: str, data: dict, idempotency: str) -> dict:
    with outbound.client() as http:
        r = http.post(f"{API}/{path}", data=data, auth=(key, ""),
                      headers={"Stripe-Version": API_VERSION, "Idempotency-Key": idempotency})
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code != 200 or not isinstance(body, dict):
        msg = str((body.get("error") or {}).get("message", ""))[:200] if isinstance(body, dict) else ""
        raise StripeError(r.status_code, f"Stripe answered {r.status_code}" + (f": {msg}" if msg else ""))
    if body.get("livemode"):
        raise StripeError(0, "Stripe answered in live mode; only the sandbox is allowed.")
    return body


def safe_url(url: str | None) -> str | None:
    """Only an https address on Stripe's own payment pages goes into an email."""
    u = urlparse(url or "")
    return url if u.scheme == "https" and (u.hostname or "") in LINK_HOSTS else None


def _reused(db: Session, r: Record) -> str | None:
    rows = db.execute(select(Reminder.link_url, Reminder.link_minor).where(
        Reminder.record_id == r.id, Reminder.link_url.is_not(None)).order_by(Reminder.sent_at.desc())).all()
    return next((url for url, minor in rows if minor == r.open_minor), None)


def for_invoice(db: Session, r: Record) -> str | None:
    """A card payment link for what is still owed on this invoice, or None when we can't make one."""
    hosted = safe_url((r.external or {}).get("hosted_invoice_url"))
    if r.source == "stripe" and hosted:
        return hosted
    if r.kind != "invoice" or r.open_minor <= 0:
        return None
    reused = _reused(db, r)
    if reused:
        return reused
    key = _key()
    if not key:
        return None
    what = f"Invoice {r.reference}" if r.reference else "Invoice"
    idem = f"copilot-link-{r.business_id}-{r.id}-{r.open_minor}"
    price = _post(key, "prices", {"currency": r.currency.lower(), "unit_amount": r.open_minor,
                                  "product_data[name]": what[:120]}, f"{idem}-price")
    link = _post(key, "payment_links", {"line_items[0][price]": price["id"], "line_items[0][quantity]": 1,
                                        "metadata[record_id]": str(r.id),
                                        "metadata[reference]": (r.reference or "")[:100]}, f"{idem}-link")
    url = safe_url(link.get("url"))
    if not url:
        raise StripeError(0, "Stripe returned a payment link we don't recognise.")
    return url
