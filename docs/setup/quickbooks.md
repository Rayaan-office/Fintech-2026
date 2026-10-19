# Accounting software (QuickBooks sandbox)

Cocent reads the books (customers, suppliers, invoices, bills and payments) and, after a person approves, adds bills with the original document attached. In our demo this is a QuickBooks Online **sandbox company**: a practice company with fake data.

Optional: only for the full setup.

## 1. Create an Intuit developer app

1. Sign up at [developer.intuit.com](https://developer.intuit.com).
2. Open the **Dashboard** and create an app. Choose **QuickBooks Online and Payments**.
3. When asked for permissions (scopes), choose only **Accounting** (`com.intuit.quickbooks.accounting`).
4. Under **Development** (not Production), open **Keys and credentials** and copy the client ID and client secret into `.env`:

```
QBO_CLIENT_ID=<client ID>
QBO_CLIENT_SECRET=<client secret>
```

5. In the same place, add this **Redirect URI**, exactly as written:

```
http://localhost:8000/connect/quickbooks/callback
```

## 2. Add a UK sandbox company

Intuit gives every developer a US sandbox company. Our demo is in pounds, so add a UK one:

1. In the developer **Dashboard**, open **Sandbox**, then **Add**.
2. Choose **QuickBooks Online Plus** and the country **United Kingdom**.

Intuit fills a new sandbox company with its own sample customers and transactions. They stay alongside ours, and you will see them in some figures.

## 3. Connect

1. In the app, signed in as the owner or finance manager, open **Connections** and press **Connect** on the accounting software card.
2. Sign in to Intuit and choose your **UK** sandbox company.

The sign-in link lasts 10 minutes and works only in the browser that started it.

## 4. Fill it

Fill the sandbox company with the demo bakery's six months of books: see [Demo data](demo-data.md). The script refuses a company outside the UK.

## How it keeps up to date

Our demo has no public address for QuickBooks' notifications, so Cocent reads QuickBooks' list of changes every 10 minutes (`BOOKS_POLL_MINUTES`). "Sync" on the card reads it straight away. `QBO_WEBHOOK_VERIFIER_TOKEN` is only needed with a public address; leave it empty.

## Check it works

The accounting software card in Connections shows the customers, suppliers and items it read. Approve a bill in the Inbox, then approve "Add to the accounting software": the bill appears in the sandbox company with the PDF attached.
