# Demo data

All our demo data comes from one made-up story: **a small bakery in Leeds that supplies local cafés**, with six months of trading. The bank feed, the card sales, the books and the emailed bills are all generated from the same story (`backend/app/demo/story.py`), so every number lines up and can be matched. Every name, address and bank detail in it is fictional.

## What the story contains

The story has patterns built in, so Cocent has real things to find:

| Built into the story | What Cocent should find |
|---|---|
| A supplier email with new bank details, from a look-alike address | A fraud warning, and two people must approve the bank change |
| Acme Supplies' flour price rises 18% this month | A price rise |
| Bright Cafe pays about 12 days late | A slow payer |
| Station Coffee Co is about 35% of sales | Reliance on one customer |
| CloudDesk's subscription keeps creeping up | Spending creep |
| VAT, payroll and rent land close together next month | A cash shortfall, and financing options that cover it |
| Amsterdam Bakehouse pays by international transfer, and each payment arrives £12 to £25 short | Bank charges, a cheaper way to pay, and reminders for its overdue invoice |

Dates are counted back from today, so the story always looks current.

## Quick look: everything at once

No sandbox accounts needed. From `backend/`:

```bash
uv run python ../tests/e2e/seed.py
```

This loads the whole story straight into its own database (`copilot_e2e`): customers, suppliers, invoices, bills, bank transactions, card payouts and their matches. It starts from empty every time. Then follow [Run Cocent yourself](README.md), step 4.

## Full setup: through the real sandboxes

With the server running and each service connected (see its guide), run these from `backend/`. Each one refuses anything but a sandbox, and running it twice adds nothing.

| Step | Command | What it does |
|---|---|---|
| 1 | Connect the bank on the Connections page | Plaid creates a test bank login with the story's 266 bank transactions and today's balance. No script needed. |
| 2 | `uv run python -m app.demo.books` | Fills the QuickBooks sandbox company with 5 customers, 6 suppliers, products, 117 invoices, 44 bills and 146 payments, dated as in the story, with 20% VAT. Refuses a company outside the UK. |
| 3 | `uv run python -m app.demo.payments` | Fills the Stripe sandbox with the same customers, a week of card sales, a declined card, a refund, a card dispute, a paid invoice and an open deposit invoice. Refuses a sandbox outside the UK. |
| 4 | `uv run python -m app.demo.emails` | Sends the emailed bills to the test inbox (below). |

The bills the story sends by email are left out of the books on purpose: they reach the accounting software only after someone approves them in Cocent.

### The demo emails

Send them all, or name the ones you want, for example `uv run python -m app.demo.emails fraud spoof`.

| Name | Email | What Cocent does |
|---|---|---|
| `acme` | Acme Supplies' weekly stock bill (flour up 18%) | Reads it, checks it and asks for approval |
| `energy` | BrightSpark's monthly energy bill | Reads it and asks for approval |
| `insurance` | Annual insurance renewal | Reads it and asks for approval |
| `repairs` | Oven repair bill from a small firm, without an email signature | Reads it, noting the sender couldn't be checked |
| `receipt` | CloudDesk card receipt, text only | Turns the email itself into a document |
| `fraud` | Acme's bill from a look-alike address, with new bank details | Fraud warnings; the bank change needs two people |
| `spoof` | An email pretending to be from Acme's real address | Refused, and the owner is told |

Each email has a fixed message ID, so sending it twice shows the duplicate being ignored.

## Other ways in

- **Upload:** any PDF, photo or spreadsheet on the Documents page, or from a phone with "Use your phone" (the phone must be on the same Wi-Fi in development).
- **Sample bills:** after the quick-look seed, `tests/e2e/.data/` holds two sample PDFs to upload: a normal Acme bill and one with changed bank details.

## Sign-ins

| Setup | File (never committed) | People |
|---|---|---|
| Quick look | `tests/e2e/e2e-credentials.local.json` | Owner, bookkeeper, employee |
| Full setup | `demo-credentials.local.json` | Owner, finance manager, bookkeeper, employee |

Passwords are made up randomly when the file is created and are only ever stored in that file.
