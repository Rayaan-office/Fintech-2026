# Bank account (Plaid sandbox)

Cocent reads the business bank account's transactions and balance. In our demo this is Plaid's **sandbox**, with a test bank (Royal Bank of Plaid, UK). Cocent asks only for transactions, the least data Plaid offers.

Optional: only for the full setup.

## 1. Get the sandbox keys

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com). The sandbox is free.
2. Open **Developers**, then **Keys**.
3. Copy the **client ID** and the **Sandbox** secret (never the Production one) into `.env`:

```
PLAID_CLIENT_ID=<client ID>
PLAID_SECRET=<sandbox secret>
```

Leave the other Plaid lines as they are (`PLAID_ENV=sandbox`, `PLAID_PRODUCTS=transactions`, `PLAID_COUNTRY_CODES=GB`). Nothing else needs setting up in the Plaid dashboard.

## 2. Connect

In the app, signed in as the owner, open **Connections** and press **Connect** on the bank card.

Cocent creates a test bank login at Plaid, filled with our demo bakery's six months of bank transactions (about 280), so the bank feed matches the books and the card sales. Plaid sends the last 30 days at once and the rest a few seconds later.

## How it keeps up to date

Plaid normally announces new transactions to a public address. Our demo runs without one, so Cocent reads the bank every 15 minutes instead (`BANK_POLL_MINUTES`), and every minute while the history is still arriving. "Sync" on the bank card reads it straight away.

## Check it works

The bank card in Connections shows "1 account" and the transactions it read. The Home page shows today's cash, and Cash flow shows the forecast.
