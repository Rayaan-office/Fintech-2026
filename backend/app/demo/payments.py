"""The bakery's card sales, put into the Stripe sandbox (UK, GBP).

    uv run python -m app.demo.payments

Stripe can't backdate payments, so the sandbox holds the card sales from the day this runs:
about a week's worth, the size of one weekly payout in the story. The six months before
that are in the bank feed as weekly "STRIPE PAYMENTS UK PAYOUT" credits.

It also adds the story's customers, a special order invoice that was paid by card, a
catering deposit invoice that is still open, a declined card, a refund and a card dispute.
Everything is tagged with a key, so running it again adds nothing.

Uses STRIPE_SEED_KEY (sandbox only). Refuses a live key, and a sandbox that isn't in the UK.
"""

import random
import sys

from ..config import get_settings
from ..connectors import outbound
from ..connectors.stripe_conn import API, API_VERSION
from . import story

_s = get_settings()
TAG = "copilot_key"

COUNTER_ITEMS = [("Sourdough loaf", 420), ("Croissant", 180), ("Cinnamon bun", 210), ("Seeded rye loaf", 460),
                 ("Coffee and pastry", 650), ("Box of 6 pastries", 1150), ("Brownie", 290)]
ONLINE_ITEMS = [("Celebration cake (collection)", 3200), ("Brunch box for 4", 2800), ("Box of 12 pastries", 2150)]


class SeedError(Exception):
    pass


class Stripe:
    def __init__(self):
        key = _s.stripe_seed_key.get_secret_value() if _s.stripe_seed_key else ""
        if not key.startswith(("sk_test_", "rk_test_")):
            raise SeedError("STRIPE_SEED_KEY must be a sandbox key (sk_test_… or rk_test_…).")
        self._auth = (key, "")
        self._http = outbound.client(timeout=30)

    def call(self, method: str, path: str, data: dict | None = None, key: str | None = None,
             ok_codes: tuple = ()) -> dict:
        headers = {"Stripe-Version": API_VERSION}
        if key:
            headers["Idempotency-Key"] = f"copilot-demo-v2-{key}"
        r = self._http.request(method, f"{API}/{path}", auth=self._auth, headers=headers,
                               params=data if method == "GET" else None, data=data if method != "GET" else None)
        body = r.json()
        if r.status_code >= 400 and r.status_code not in ok_codes:
            raise SeedError(f"{method} {path}: Stripe answered {r.status_code}: "
                            f"{body.get('error', {}).get('message', '')[:200]}")
        if body.get("livemode"):
            raise SeedError("Stripe answered in live mode; refusing.")
        return body

    def tagged(self, path: str, params: dict | None = None) -> dict[str, dict]:
        """Objects we created before, by tag."""
        out: dict[str, dict] = {}
        params = {"limit": 100, **(params or {})}
        for _ in range(20):
            page = self.call("GET", path, params)
            for o in page["data"]:
                tag = (o.get("metadata") or {}).get(TAG)
                if tag:
                    out.setdefault(tag, o)
            if not page.get("has_more") or not page["data"]:
                break
            params["starting_after"] = page["data"][-1]["id"]
        return out


def _slug(name: str) -> str:
    return "-".join(name.lower().replace("&", "and").split())


def sales(seed: int = 2026) -> list[dict]:
    """This week's card sales: counter sales, some online orders, two by regular customers."""
    rnd = random.Random(seed)
    target = rnd.randint(780, 1380) * 100
    out, total = [], 0
    while total < target and len(out) < 80:
        n = len(out) + 1
        online = rnd.random() < 0.2
        items = rnd.sample(ONLINE_ITEMS if online else COUNTER_ITEMS, rnd.randint(1, 2 if online else 3))
        amount = sum(p * (1 if online else rnd.randint(1, 3)) for _, p in items)
        out.append({"key": f"sale-{n:02d}", "amount": amount,
                    "description": ("Online order: " if online else "Counter sale: ") + ", ".join(i for i, _ in items),
                    "card": rnd.choice(["pm_card_visa", "pm_card_visa_debit", "pm_card_mastercard"])})
        total += amount
    out[3]["customer"] = "Corner Deli"          # topped up an order at the counter
    out[3]["description"] = "Extra order at the counter: sourdough loaves"
    out[9]["customer"] = "Green Leaf Bistro"
    out[9]["description"] = "Extra order at the counter: box of 12 pastries"
    out[5]["refund"] = True                      # cake returned
    out.append({"key": "sale-declined", "amount": 1150, "description": "Counter sale: box of 6 pastries",
                "card": "pm_card_visa_chargeDeclined"})
    out.append({"key": "sale-disputed", "amount": 4600, "description": "Online order: brunch box for 4, brownies",
                "card": "pm_card_createDispute"})
    return out


def check_account(api: Stripe) -> None:
    acct = api.call("GET", "account")
    if acct.get("country") != "GB":
        raise SeedError(f"This sandbox is in {acct.get('country')!r}, not the UK. Create a UK sandbox first "
                        "(see .env.example).")


def customers(api: Stripe) -> dict[str, str]:
    have = api.tagged("customers")
    ids = {}
    for party in story.CUSTOMERS:
        tag = f"customer-{_slug(party.name)}"
        if tag not in have:
            have[tag] = api.call("POST", "customers", {"name": party.name, "email": party.email,
                                                       "preferred_locales[]": "en-GB", f"metadata[{TAG}]": tag}, key=tag)
        ids[party.name] = have[tag]["id"]
    return ids


def vat_rate(api: Stripe) -> str:
    have = api.tagged("tax_rates", {"active": "true"})
    if "vat-20" not in have:
        have["vat-20"] = api.call("POST", "tax_rates", {"display_name": "VAT", "percentage": "20", "inclusive": "false",
                                                        "country": "GB", "jurisdiction": "GB",
                                                        f"metadata[{TAG}]": "vat-20"}, key="vat-20")
    return have["vat-20"]["id"]


def invoices(api: Stripe, cust: dict[str, str], vat: str) -> int:
    plan = [
        ("invoice-green-leaf-cake", "Green Leaf Bistro", "Special order: 3-tier celebration cake", 8500, True),
        ("invoice-harrogate-deposit", "Harrogate Grand Hotel", "Deposit: Christmas afternoon tea pastries", 45000, False),
    ]
    have = api.tagged("invoices")
    made = 0
    for tag, who, what, net, pay in plan:
        inv = have.get(tag)
        if not inv:
            inv = api.call("POST", "invoices", {
                "customer": cust[who], "collection_method": "send_invoice", "days_until_due": "14", "currency": "gbp",
                "default_tax_rates[]": vat, "description": what, "auto_advance": "false", f"metadata[{TAG}]": tag,
            }, key=tag)
            api.call("POST", "invoiceitems", {"customer": cust[who], "invoice": inv["id"], "amount": str(net),
                                              "currency": "gbp", "description": what}, key=f"{tag}-item")
            made += 1
        if inv["status"] == "draft":
            inv = api.call("POST", f"invoices/{inv['id']}/finalize", {"auto_advance": "false"}, key=f"{tag}-final")
        if pay and inv["status"] == "open":
            card = api.call("POST", "payment_methods/pm_card_visa/attach", {"customer": cust[who]}, key=f"{tag}-card")
            api.call("POST", f"invoices/{inv['id']}/pay", {"payment_method": card["id"]}, key=f"{tag}-pay-card")
    return made


def card_sales(api: Stripe, cust: dict[str, str]) -> tuple[int, int]:
    have = api.tagged("payment_intents")
    refunds = api.tagged("refunds")
    made = refunded = 0
    for sale in sales():
        pi = have.get(sale["key"])
        if not pi:
            data = {"amount": str(sale["amount"]), "currency": "gbp", "description": sale["description"],
                    "payment_method": sale["card"], "confirm": "true", "automatic_payment_methods[enabled]": "true",
                    "automatic_payment_methods[allow_redirects]": "never",
                    f"metadata[{TAG}]": sale["key"]}
            if sale.get("customer"):
                data["customer"] = cust[sale["customer"]]
            body = api.call("POST", "payment_intents", data, key=sale["key"], ok_codes=(402,))
            pi = body.get("error", {}).get("payment_intent") or body  # a declined card answers 402
            made += 1
        if sale.get("refund") and pi.get("status") == "succeeded" and f"refund-{sale['key']}" not in refunds:
            api.call("POST", "refunds", {"payment_intent": pi["id"], "reason": "requested_by_customer",
                                         f"metadata[{TAG}]": f"refund-{sale['key']}"}, key=f"refund-{sale['key']}")
            refunded += 1
    return made, refunded


def main() -> None:
    api = Stripe()
    check_account(api)
    cust = customers(api)
    vat = vat_rate(api)
    new_invoices = invoices(api, cust, vat)
    new_sales, new_refunds = card_sales(api, cust)
    print(f"Stripe sandbox ready: {len(cust)} customers, {new_invoices} new invoices, "
          f"{new_sales} new card payments, {new_refunds} new refunds.")


if __name__ == "__main__":
    try:
        main()
    except SeedError as e:
        sys.exit(str(e))
