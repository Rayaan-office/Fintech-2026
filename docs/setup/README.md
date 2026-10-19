# Run Cocent yourself

There are two ways to try Cocent on your own computer. Both use test data only: no real money, no real accounts.

| | Quick look | Full setup |
|---|---|---|
| What you get | The whole app, filled with our demo bakery's six months of records | The same, plus live connections to a test bank, payment platform, accounting software and email inbox |
| Accounts you need | One AI gateway key | The AI gateway key, plus free sandbox accounts at Stripe, Plaid and Intuit (QuickBooks) |
| Time | About 15 minutes | About an hour, mostly creating the sandbox accounts |

If you only want to see Cocent working, our [demo video](../video/cocent-demo.mp4) shows the full story in under five minutes.

## What you need on your computer

| Tool | Why | How to get it |
|---|---|---|
| Docker Desktop | Runs the database, the document archive and the test email inbox | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Python 3.12 and uv | Runs the server | [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) (uv installs the right Python for you) |
| Node.js 20.19 or newer | Runs the app in the browser | [nodejs.org](https://nodejs.org/) |
| Tesseract and libmagic | Read text from photos, and check what a file really is | Mac: `brew install tesseract libmagic`. Ubuntu: `sudo apt install tesseract-ocr libmagic1` |
| Stripe CLI (full setup only) | Passes card-payment notifications to your computer | Mac: `brew install stripe/stripe-cli/stripe`. Others: [stripe.com/docs/stripe-cli](https://docs.stripe.com/stripe-cli) |

## Step 1: Download the code

```bash
git clone https://github.com/Rayaan-office/cocent-sme-finance-copilot.git
```

```bash
cd cocent-sme-finance-copilot
```

## Step 2: Settings

```bash
cp .env.example .env
```

Open `.env` in a text editor. Every line says what it is for.

- **Lines marked [LOCAL]** are passwords and keys for our own services. Make each one up once. For the keys, run this and paste the result:

  ```bash
  openssl rand -base64 32
  ```

- **Lines marked [YOU]** come from an outside service. Each has its own guide:

  | Service | Needed for | Guide |
  |---|---|---|
  | AI gateway | Both ways | [AI gateway](ai-gateway.md) |
  | Payment platform (Stripe) | Full setup | [Stripe](stripe.md) |
  | Bank (Plaid) | Full setup | [Plaid](plaid.md) |
  | Accounting software (QuickBooks) | Full setup | [QuickBooks](quickbooks.md) |
  | Email inbox (Mailpit) | Both ways, nothing to sign up for | [Email inbox](email.md) |

- **For the quick look**, put `unused` in the Stripe, Plaid and QuickBooks key lines. The app starts without them, and those connections stay switched off.

`.env` is never committed, and its keys never reach the AI.

## Step 3: Start the services

```bash
docker compose up -d
```

This starts the database, the encrypted document archive and the test email inbox. You can see the inbox at http://localhost:8025.

## Step 4: Fill in the demo data

### Quick look

```bash
cd backend && uv run python ../tests/e2e/seed.py
```

This creates the demo bakery in its own database (`copilot_e2e`), with six months of sales, bills, bank payments and matches already in place. The sign-ins are saved to `tests/e2e/e2e-credentials.local.json`.

Then start the server on that database:

```bash
cd backend && POSTGRES_DB=copilot_e2e uv run uvicorn app.main:app --port 8000
```

### Full setup

```bash
cd backend && uv run python -m app.bootstrap && uv run python -m app.seed
```

This sets up the database and creates a demo business with one sign-in for each role (owner, finance manager, bookkeeper, employee). The sign-ins are saved to `demo-credentials.local.json`. Then start the server:

```bash
cd backend && uv run uvicorn app.main:app --port 8000
```

Next, follow [Demo data](demo-data.md) to connect each sandbox and fill it with the story.

## Step 5: Open the app

In a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in with an email and password from the sign-ins file.

- The **bookkeeper** signs in with just a password.
- The **owner** and **finance manager** also set up two-step sign-in the first time, with any authenticator app (for example Google Authenticator or 1Password).

## Step 6 (optional): Run the tests

See [Testing](../TESTING.md).

## If something goes wrong

| What you see | What to do |
|---|---|
| The server stops with "field required" | A line in `.env` is empty. For a service you aren't using, put `unused`. |
| Photos are not read | Tesseract isn't installed, or isn't on your PATH |
| Emails don't appear in the app | The server must be running before the emails are sent. In Connections, "Sync" on the email card catches up. |
| QuickBooks says the redirect address is wrong | The redirect URI in your Intuit app must be exactly `http://localhost:8000/connect/quickbooks/callback` |

## Going live

Our demo runs on one computer with sandbox services. For real businesses we would change only the following. The code stays the same.

| Part | Demo | Live |
|---|---|---|
| Email | Mailpit test inbox | A dedicated bills inbox per business, read over IMAP |
| Notifications from outside services | Read on a schedule, because we have no public address | A public HTTPS address, with every notification's signature checked |
| Outside services | Sandbox keys | Live keys with the same least access |
| Server | Started by hand | Containers behind HTTPS, with keys kept in a secrets manager |
| Database and archive | Docker on one computer | Managed Postgres with backups, and encrypted cloud storage |
