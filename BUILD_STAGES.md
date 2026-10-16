# Build stages

We build one stage per working session, then test, commit and merge it before starting the next.
Every stage ends with its tests passing in `tests/` (see [tests/README.md](tests/README.md)).
Backend stages are numbered 0–9; frontend stages F1–F6 follow the backend stage whose API they use.

## Backend stages

| Stage | What | Status |
|---|---|---|
| 0 | Foundation and document pipeline | Done |
| 1 | Frontend: see stages F1–F6 below | F1–F2 done; F3–F6 drafted |
| 2 | Email inbox connector (Mailpit) | Done |
| 3 | Payment platform connector (Stripe) | Done |
| 4 | Bank connector (Plaid) | Done |
| 5 | Accounting connector (QuickBooks) | Done |
| 6 | Ledger, matching, forecast and analysis | Done |
| 7 | Approvals, recommendations, financing and assistant | Approval engine done |
| 8 | Frontend: see stages F3–F6 below | Not started |
| 9 | Hardening and submission material | Not started |

## Stage 0: Foundation and document pipeline (done)

- Docker services: Postgres, SeaweedFS (S3-compatible archive; MinIO no longer publishes images), Mailpit.
- Settings from `.env`; separate database accounts: owner (setup only), runtime (row-level security always applies), vault (personal-detail store only).
- 28 tables; row-level security on the 22 tables tied to one business; the activity log is append-only.
- Sign-in with Argon2 passwords, lockout after 5 failures, idle and absolute session timeouts, two-step sign-in for owners and finance managers.
- Roles and permissions; fixed approval levels per action; approval engine with two-person rule, limits, Pause AI, undo for small changes.
- Tamper-evident activity log (HMAC chain) with verification.
- Encryption: connection tokens, vault values, archive files (AES-256-GCM, separate keys).
- Redaction: checksum-based detectors (cards, IBAN, UK account and sort code, VAT, NI, UTR, company number, phone, email, links, IP, postcode, street) plus Presidio for names; final scan fails closed.
- AI gateway: allowlisted models only, zero-data-retention providers only, strict JSON form, daily budget and hourly limit, gateway blocks handled.
- Document workflow (LangGraph): safety check, archive, read text (PyMuPDF / Tesseract in a time-limited worker), hide details, privacy check, AI form, checks, one retry, second opinion, supplier and fraud checks, approval proposal.
- Fraud warnings: changed bank details, duplicates, look-alike domains, failed sender checks, unusual amounts, pressure language.
- API: sign-in, inbox and approvals, documents (upload, review view, corrections, original), activity log (list, verify, CSV export), live updates, notifications, Pause AI.
- Tests: 73 passing (unit, integration, security, regression), including the full fraud drill through the API.

## Stage 2: Email inbox connector (Mailpit) (done)

- Intake that works for any inbox (`connectors/email_in.py`); Mailpit is only the transport. Production would use the same code behind an IMAP reader.
- Mailpit's notification gives a message ID; we fetch the email ourselves, route it by To, Cc or Bcc to the business's bills inbox, and process it once per Message-ID (a content fingerprint if there is none).
- Sender checks: our own DKIM check, plus SPF, DKIM and DMARC from our receiving server's Authentication-Results only (headers under any other server's name are ignored). Demo domains get local signing keys in `backend/.local/` (git-ignored).
- Refused, with a notification to the owner: DMARC failed, a broken signature from the sender's own domain, automatic replies and delivery reports, mail from the bills inbox itself, over 25 MB, more than 200 an hour.
- Each attachment becomes a document (up to 10; files inside a forwarded email count, logos in the email's text don't); emails with no attachment become a text document.
- "Sync" on the email card catches up on emails that arrived while the app wasn't listening.
- Sending approved emails: payment reminders (to customers) and supplier questions, always to the address on record, never to a bills inbox; plain text, marked as automatic so out-of-office replies don't loop. Drafting them is Stage 7.
- Demo emails from the story: `cd backend && uv run python -m app.demo.emails` sends Acme's stock bill, BrightSpark's energy bill, the insurance renewal, the oven repair (unsigned), the CloudDesk card receipt (text only), the fraud drill (look-alike domain) and a spoofed Acme email (refused). Add names to send only some, e.g. `fraud spoof`. Message-IDs are fixed, so sending twice shows duplicates being ignored.
- Fixed the demo suppliers' phone and VAT numbers, which weren't valid and so weren't recognised and hidden.
- AI gateway: a temporary provider error (429, 5xx, "Provider returned error") now gets one more try after a short wait (2 s, or the provider's Retry-After up to 10 s). Found in the live test, where one such error sent the fraud email to review before its checks ran.
- Live test with the real AI: the Acme bill passed first time; the fraud email was caught (changed bank details, look-alike sender) and the bookkeeper could not approve the bank change or the bill.
- Tests: 66 new (30 unit, 16 integration through the real Mailpit, 20 regression); 139 backend tests pass in all. Bugs fixed in the drafted code: text-only emails were refused as raw email, a Bcc to the inbox was dropped (and an email to two businesses reached only one), a malformed notification caused a server error, and any sender could forge the sender-check verdict.

## Stage 3: Payment platform connector (Stripe) (done)

- Decided: a new UK Stripe sandbox, so payments, fees, balance and payouts are all in GBP like the bank feed. The old UAE sandbox (AED balance, USD test data) is left as it is.
- Sync (`connectors/stripe_conn.py`): customers (joined to customers we already know by name, linked by Stripe ID after that; email kept in the personal-detail store), invoices with VAT and lines, which card payment paid which invoice (Stripe's invoice payments), card payments with their Stripe fee as a separate record, refunds, disputes with the dispute fee, payouts and the balance. Written-off invoices and failed payouts are not counted as money on its way.
- Safety: only a read-only sandbox key (`rk_test_`) is used; the API version is pinned (2026-09-30); every object is checked against a fixed format and bad ones are skipped and counted; live-mode data is refused.
- Notifications: signature checked (and no older than five minutes), each handled once, unrelated ones ignored, nothing taken from the notification itself. A burst of notifications leads to at most two reads. Forwarded in development by `uv run python -m app.demo.stripe_listen` (Stripe CLI with the sandbox key, no `stripe login`); `--save-secret` writes the notification secret into `.env` without showing it.
- Demo data (`uv run python -m app.demo.payments`): the story's five customers, a week of card sales (counter and online, the size of one weekly payout), a declined card, a refund, a card dispute, a paid special-order invoice and an open catering deposit invoice, all with 20% VAT. Stripe can't backdate, so the six months before are in the bank feed as weekly payouts. Refuses a sandbox outside the UK; tagged, so running it twice adds nothing.
- Failed syncs now show on the connection card (for every connector), with a clear reason (key rejected, missing permission, account linked to another business).
- Tests so far: 37 new (8 unit, 22 integration against a fake Stripe, 7 regression) plus 10 live contract tests; 176 backend tests pass. Bugs fixed in the drafted code: every genuine notification was refused (stripe-python 16 events aren't dicts), card payments were never linked to their invoice and VAT was lost (fields Stripe removed), failed payouts and written-off invoices counted as expected money, failed syncs left no error, and every notification started a full re-read.
- Live check with the new UK sandbox: the demo data went in (33 card payments worth £1,088.10 including the paid invoice and the disputed order, 1 declined, 1 refund, 1 dispute, 2 invoices), and running it again added nothing. All 10 live contract tests pass, including that our key can't change anything in Stripe. In the running app, Stripe connected (5 customers, 2 invoices, 33 payments with fees, refund, dispute, GBP balance); a new card sale arrived through `stripe listen` within a second and was read back from Stripe; the same notification resent was ignored.
- Demo-data fixes found in the live run: a card has to be attached to the customer before paying their invoice, and this API version no longer accepts `payment_method_types`.

## Stage 4: Bank connector (Plaid) (done)

- The demo bank account is a Plaid custom test user generated from the story: one GBP current account, 266 transactions over six months, today's balance £20,247.79. It sits at Royal Bank of Plaid, Plaid's UK test bank; the bank we used before has an OAuth screen, which custom test users don't support.
- Sync (`connectors/plaid_conn.py`): Transactions only (the least data), read from where we stopped last time. Amounts are converted to pence exactly; every account and transaction is checked against a fixed format and bad ones are skipped and counted; only current and savings accounts are kept. Changed transactions are updated, removed ones voided, and a pending payment that posts keeps its record.
- If the bank changes data while we page through it, the read starts again from the beginning, throwing away the half-read pages. One read per business at a time, across processes.
- Background schedule (`app/scheduler.py`, inside the API): we have no public address, so Plaid can't notify us. Each connected bank is read every 15 minutes, and every minute while Plaid is still sending the history (it sends the last 30 days at once and the rest seconds later). Expired banks wait for the person; quiet reads don't fill the activity log.
- Expired connections: the card says "The bank connection has expired. Reconnect." Reconnecting makes a new link with new ids; our records carry over to it (keeping their matches), and old ones the bank no longer has are voided once the full history is in. The old link is removed at Plaid.
- Tests: 25 new (4 unit, 17 integration against a fake Plaid, 4 regression) plus 4 live contract tests; 201 backend tests pass. Bugs fixed in the drafted code: only the last 30 days ever arrived, reconnecting doubled every bank transaction, a change at the bank during paging failed the sync, and a pending payment lost its record when it posted.
- Live check: all 266 transactions and the balance arrive from the real sandbox in our shapes, and an expired login is reported as expired. The demo business's existing bank connection was reconnected through the new code: all 266 records carried over, none duplicated or voided. The schedule, running in the API, then read the bank on its own.

## Stage 5: Accounting connector (QuickBooks) (done)

- The demo books are a UK QuickBooks sandbox company (GB, pounds, UK VAT codes). Intuit fills a new sandbox company with its own sample customers and transactions; those stay alongside ours.
- Sign-in with Intuit: the link is signed, runs out after 10 minutes, and only works in the browser that started it (a one-time cookie, cleared after use). Only owners and finance managers can connect. One QuickBooks company belongs to one business. `/connect/quickbooks/start` goes straight to Intuit's sign-in page.
- Tokens are encrypted. Intuit replaces the refresh token on every refresh, so a refreshed token is saved at once in its own transaction. If Intuit refuses it, the card says "The QuickBooks connection has expired. Reconnect." and the schedule waits for the person. Disconnecting gives the access back to Intuit.
- Sync (`connectors/quickbooks.py`): payment terms, customers, suppliers, invoices, bills, customer payments, bill payments and purchases, with VAT, lines, the expense account and which payment settled which invoice or bill. Amounts are converted to pence exactly; every row is checked against a fixed format and bad ones are skipped and counted, never voided. Voided items (QuickBooks sets them to zero) and deleted ones are void with us.
- Keeping up to date: the background schedule reads QuickBooks' change feed every 10 minutes (`BOOKS_POLL_MINUTES`), starting a few minutes before the last read so nothing falls in between. The feed only keeps 30 days and stops at 1,000 changes per type, so an older or cut-short feed means a full read, which also voids anything QuickBooks no longer has. Quiet reads don't fill the activity log.
- Notifications, for when there is a public address: signature checked, current (CloudEvents) and older formats, each handled once, and one change-feed read per company however many arrive.
- Adding approved bills (level 3, one person): the bill goes in with the plain VAT code matching its rate (for example 20.0% S, never reverse charge), to the account the supplier's earlier bills used, with the original attached. The supplier is found by name or added. Each write carries a request id, so if QuickBooks fails partway the approval isn't used up, and approving again doesn't make a second bill. A bill we added is recognised on the next read, so it is never counted twice; if it is paid in QuickBooks, our record shows that.
- Demo books (`cd backend && uv run python -m app.demo.books`): the story's five customers, six suppliers, products, 117 invoices, 44 bills and 146 payments, backdated to their story dates with 20% VAT. The five bills the demo sends by email are left out; they reach QuickBooks after approval. Refuses a company outside the UK; running it again adds nothing.
- Tests: 39 new (29 integration against a fake QuickBooks, 10 regression); 240 backend tests pass. Bugs fixed in the drafted code: a failed read could lose the refreshed sign-in for good, changes made during the first read were never picked up, deleted bills stayed open, voided invoices counted as paid, a month without reading broke every read, a second company overwrote the first one's records, retrying an approved bill added it twice, a bill we added came back as a second bill, and the sign-in link could be finished in another browser.
- Live check with the UK sandbox: connected through Intuit's sign-in, then filled with the demo books. Every invoice and bill total matched the story to the penny, and the next read took in the 307 new items through the change feed. The emailed Acme bill AS-1005 was added through the approval handler: the right supplier, 20.0% S VAT, £658.56 exactly, the PDF attached, and the next read did not count it twice. The schedule, running in the API, then read QuickBooks on its own.

## Stage 6: Ledger, matching, forecast and analysis (done)

- Cash position (`analytics/ledger.py`): every connected bank account and payment-platform balance, in the business currency. Accounts and items in other currencies are left out and listed, since we hold no exchange rates. Each bank line is labelled as one of: the same money as an invoice, bill or payout we already have; card sales; tax; financing; salaries; rent; or everyday spending. That way nothing is counted twice.
- Matching on real synced data (`analytics/matching.py`):
  - We never suggest a payment that names a different invoice of ours, or a different customer or supplier.
  - We never pair two items from the same accounting or payment system, since QuickBooks and Stripe already record what each payment settled.
  - A bank payment that is the same money as an invoice or bill already paid in the books is linked without changing either. It is found by its number, or for direct debits and card payments by party, amount and date.
  - Suggestions that no longer fit are withdrawn, and their approvals cancelled.
  - A turned-down pair is never suggested again.
  - QuickBooks invoices and bills now get the date they were paid.
- 90-day forecast (`analytics/forecast.py`), day by day:
  - unpaid invoices, placed by each customer's own payment habits;
  - bills on their due dates; overdue ones are assumed paid now;
  - repeating bank items such as rent, payroll, the van loan and card-sales payouts;
  - regular customers and suppliers, spotted from how often they are invoiced or billed;
  - VAT, estimated from the quarter's invoices, bills and card sales;
  - the everyday pattern by day of the week;
  - planned costs.

  Best and worst case come from customers' past payment spread and everyday variation. Money already sitting in the payment platform isn't counted again with the next payout.
- Early warnings: the first day cash goes below the safety level (by default two weeks of usual spending, or one the owner sets), naming the biggest payments that cause it. Graded watch, warning or urgent.
- What-if: planned costs, bills left out or moved. The forecast is recalculated on a copy, and the result shows the new lowest point and how much is missing below the safety level. Planned costs can be kept (finance managers and owners); real records never change.
- Business health (`analytics/health.py`):
  - profit and loss by month, before VAT; months our records only partly cover are marked;
  - spending by category and top suppliers;
  - who owes you, by how overdue;
  - days to get paid and cash runway;
  - the four health checks in plain words.
- Why cash changed: this month so far against the same days last month (or 30 days against the 30 before), split into ranked reasons with the payers and payees behind each. The reasons add up exactly to the change. The words are a plain template for now; Stage 7 has the AI write them, fact-checked.
- API (`api/insights.py`), read-only for bookkeepers and up:
  - `/api/cash`, `/api/cash-flow`, `/api/cash-flow/what-if` and `/api/cash-flow/why`;
  - `/api/business-health` and `/api/home`;
  - `/api/matches` (accepting and rejecting still go through the approvals inbox);
  - `/api/planned-items` and `/api/settings/safety-level` (owner only).
- Live check on the connected sandboxes:
  - after a restart, the schedule withdrew the 15 wrong suggestions and cancelled their approvals;
  - it linked 146 bank payments to invoices and bills already paid in QuickBooks, and gave 156 QuickBooks items their paid dates;
  - every bank line is now explained except bank-only ones (payouts, payroll, rent, the van loan, everyday spending).

  The forecast's first warning: "VAT (estimated) on 7 November will take you below your safety level in 22 days."

  Intuit's sample data in the sandbox company is in the figures too: it adds old overdue bills, about £26k of June sales, and VAT on its invoices.
- Tests: 41 new, 281 backend tests pass.
  - 28 integration tests run on the whole demo story loaded as books and a bank feed. Each figure is checked against an answer worked out from the story itself: profit and loss to the penny every month, the VAT estimate, rent on the 1st, payroll on the 28th, and every paid item's bank payment linked with nothing wrongly suggested.
  - 13 regression tests.
- Bugs fixed:
  - In the drafted matching code:
    - all 15 suggestions on the real data were wrong: payments naming another invoice, payments from another customer, and payments QuickBooks had already applied;
    - turning down a suggestion reopened a paid invoice;
    - turned-down pairs came back;
    - stale suggestions stayed waiting.
  - Found while building: the ledger could read another business's settings, and a what-if could be a penny out.

## Stage 7: Approvals, recommendations, financing and assistant

- Remaining action handler: lender pack sharing. (Sending reminders and supplier emails was built in Stage 2, adding approved bills to the accounting software in Stage 5; Stage 7 drafts the emails.)
- Recommendations agent (rules first, AI words them, fact-checked), dismiss and mute.
- Business profile, financing catalog, matching, cost, forecast effect, readiness, lender pack PDF.
- Chat assistant (LangGraph) with read-only tools and fact-checked answers.
- Tests: rule triggers, fact checks, approval paths, assistant tool limits.

## Stage 9: Hardening and submission

pip-audit and npm audit, end-to-end tests, deployment and testing docs, security self-assessment, execution evidence (activity log and sandbox logs), deck and demo video.

## Frontend stages

| Stage | What | Uses backend stage | Status |
|---|---|---|---|
| F1 | Setup, design tokens, app shell, sign-in and two-step | 0 | Done |
| F2 | Shared components and test setup | 0 | Done |
| F3 | Inbox, documents review, activity, connections | 0, 2–5 | Drafted |
| F4 | Home, cash flow, business health | 6 | Drafted |
| F5 | Recommendations, financing, Ask (chat) | 7 | Drafted |
| F6 | Interaction features and end-to-end journeys | All | Drafted (search, shortcuts dialog) |

"Drafted" means page layouts and data hooks exist but have not been tried against real endpoints. Each stage finishes them: connect to the real API, add tests, check the screens.

Endpoints the drafts expect: `POST /api/search` (search terms stay out of URLs and logs), `/api/business-health`, and document pages served as images (`pages[]`), because our CSP blocks showing PDFs inside the page.

### F1: Setup, design tokens, app shell, sign-in

- Vite, React, TypeScript, Tailwind and shadcn/ui, with versions pinned; dev proxy to the API.
- Design tokens (light and dark), Inter self-hosted, tabular figures.
- Left menu (shown by permission), top bar, side panel and focused panel; phone layout.
- Sign-in, two-step setup (QR code) and code entry; friendly error messages.
- A placeholder for each page.

### F2: Shared components and test setup

- Money (pence smaller, privacy mode), approval badge, confirmation card, AI label with "What the AI saw", empty, loading and error states, number count-up, status dot, initials, help hints, chart with table view.
- Vitest tests for each component; Playwright set up with a sign-in journey.

### F3: Inbox, documents, activity, connections

- Inbox tabs (to review, needs approval, done) with confirmation cards, "1 of 2 approvals", undo messages.
- Document review: original on the left with highlights, extracted fields on the right, corrections, live processing journey, "What the AI saw".
- Activity timeline with filters, "Log intact" badge and CSV export.
- Connections cards: status, last sync, connect, sync and reconnect; QuickBooks sign-in.
- Upload and in-app photo (jscanify); "My receipts" for employees.

### F4: Home, cash flow, business health

- Home: greeting, Today briefing, cash today with a small forecast, three cards, quick buttons.
- Cash flow: lowest point headline, forecast with best and worst band and bill markers, warnings, drag a bill, add a planned cost.
- Business health: four headline numbers, one switchable chart, health checks.

### F5: Recommendations, financing, Ask

- Recommendation cards with evidence in the side panel, dismiss and next step.
- Financing: gap, option cards, amount and term sliders, forecast effect, readiness checklist, lender pack.
- Ask: chat with small charts, tables, action buttons, follow-up options, approvals in the chat, voice input.

### F6: Interaction features and end-to-end journeys

- Search everything (Ctrl/⌘ K), keyboard shortcuts and the `?` dialog, swipe review on phones.
- Show your work (click any number to open its source), phone handoff by QR code, Today briefing read aloud.
- Fraud drill polish, reduce-motion check, accessibility pass.
- Playwright journeys for the demo: upload a bill, approve it, fraud drill, what-if, ask a question.
