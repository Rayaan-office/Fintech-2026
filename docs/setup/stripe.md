# Payment platform (Stripe sandbox)

Cocent reads card sales, fees, refunds, disputes, invoices and payouts from the payment platform. In our demo this is a Stripe **sandbox**: a practice account with fake money. Cocent only reads from it, and refuses any live key.

Optional: only for the full setup.

## 1. Create a UK sandbox

We use a UK sandbox so that everything is in pounds, like the bank account.

1. Sign up or sign in at [dashboard.stripe.com](https://dashboard.stripe.com).
2. Open the account menu (top left), then **Switch to sandbox**, then **Create sandbox**.
3. Choose **Create an account from scratch**.
4. In that sandbox, go to **Settings**, then **Business**, then **Account details**, and set the country to **United Kingdom**.

## 2. Create the keys

Cocent uses up to three keys, each with the least access it needs. All of them come from the sandbox (they start with `rk_test_` or `sk_test_`).

| `.env` line | Key | Access to give it | Used for |
|---|---|---|---|
| `STRIPE_API_KEY` | A **restricted key** (Developers, then API keys, then Create restricted key) | **Read** on Balance, Balance transactions, Charges, Customers, Disputes, Events, Invoices, PaymentIntents, Payouts and Refunds. **None** on everything else. | Everything the app reads |
| `STRIPE_SEED_KEY` | The sandbox's **secret key** (`sk_test_`) | Full sandbox access | Only our demo-data script and the notification forwarder below. The app itself never uses it. |
| `STRIPE_LINKS_KEY` (optional) | A second restricted key | **Write** on Products, Prices and Payment Links. **None** on everything else. | Card payment links in approved payment reminders. Leave it empty and reminders go out without a link. |

## 3. Receive notifications

Stripe tells Cocent when a card payment happens. Because your computer has no public address, the Stripe CLI passes these notifications on. Cocent runs it with your sandbox key, so you never need `stripe login`.

Once, from `backend/`, to save the notification secret into `.env` (it is never printed):

```bash
uv run python -m app.demo.stripe_listen --save-secret
```

Then keep this running in its own terminal while you use the app:

```bash
uv run python -m app.demo.stripe_listen
```

## 4. Connect and fill it

1. In the app, signed in as the owner, open **Connections** and press **Connect** on the payment platform card.
2. Fill the sandbox with the demo bakery's card sales: see [Demo data](demo-data.md).

## Check it works

The payment platform card in Connections shows the last sync, with the number of customers, payments and fees it read. A new test payment in the Stripe dashboard appears within a few seconds while the forwarder is running.
