"""Forward Stripe sandbox notifications to our API, without a public address or `stripe login`.

    uv run python -m app.demo.stripe_listen --save-secret   # once: writes STRIPE_WEBHOOK_SECRET into .env
    uv run python -m app.demo.stripe_listen                 # keep running while you use the app

Uses the Stripe CLI with STRIPE_SEED_KEY (sandbox only), passed in the environment, not on the
command line. The notification secret is written into .env and never printed.
"""

import os
import re
import shutil
import subprocess
import sys

from ..config import ROOT, get_settings

_s = get_settings()
EVENTS = ",".join([
    "customer.created", "customer.updated", "customer.deleted",
    "invoice.finalized", "invoice.paid", "invoice.voided", "invoice.marked_uncollectible", "invoice.updated",
    "charge.succeeded", "charge.refunded", "charge.dispute.created", "charge.dispute.closed",
    "refund.created", "refund.updated", "payout.created", "payout.paid", "payout.failed", "balance.available",
])


def _env() -> dict:
    key = _s.stripe_seed_key.get_secret_value() if _s.stripe_seed_key else ""
    if not key.startswith(("sk_test_", "rk_test_")):
        sys.exit("STRIPE_SEED_KEY must be a sandbox key (sk_test_… or rk_test_…).")
    if not shutil.which("stripe"):
        sys.exit("The Stripe CLI isn't installed (brew install stripe/stripe-cli/stripe).")
    return {**os.environ, "STRIPE_API_KEY": key}


def save_secret() -> None:
    out = subprocess.run(["stripe", "listen", "--print-secret"], env=_env(), capture_output=True, text=True,
                         timeout=60)
    secret = out.stdout.strip()
    if out.returncode != 0 or not re.fullmatch(r"whsec_[A-Za-z0-9]+", secret):
        sys.exit("The Stripe CLI didn't give a notification secret.")
    path = ROOT / ".env"
    text = path.read_text()
    line = f"STRIPE_WEBHOOK_SECRET={secret}"
    text, n = re.subn(r"(?m)^STRIPE_WEBHOOK_SECRET=.*$", line, text)
    path.write_text(text if n else text.rstrip("\n") + "\n" + line + "\n")
    print("Saved the notification secret to .env. Restart the API so it picks it up.")


def listen() -> None:
    url = f"{_s.api_base_url.rstrip('/')}/webhooks/stripe"
    os.execvpe("stripe", ["stripe", "listen", "--events", EVENTS, "--forward-to", url], _env())


if __name__ == "__main__":
    save_secret() if "--save-secret" in sys.argv[1:] else listen()
