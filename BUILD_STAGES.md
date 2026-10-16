# Build stages

We build one stage per working session, then test, commit and merge it before starting the next.
Every stage ends with its tests passing in `tests/` (see [tests/README.md](tests/README.md)).
Backend stages are numbered 0–9; frontend stages F1–F6 follow the backend stage whose API they use.

## Backend stages

| Stage | What | Status |
|---|---|---|
| 0 | Foundation and document pipeline | Done |
| 1 | Frontend: see stages F1–F6 below | F1–F3 done; F4–F6 drafted |
| 2 | Email inbox connector (Mailpit) | Done |
| 3 | Payment platform connector (Stripe) | Done |
| 4 | Bank connector (Plaid) | Done |
| 5 | Accounting connector (QuickBooks) | Done |
| 6 | Ledger, matching, forecast and analysis | Matching drafted |
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

## Stage 6: Ledger, matching, forecast and analysis

- Cash position across accounts in the business currency.
- Matching rules and scoring on real synced data, combinations, accept / reject flows.
- 90-day forecast with best and worst case, repeating items, everyday pattern.
- Early warnings, business health, why cash changed, what-if.
- Tests: each calculation against the story's known answers.

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
| F3 | Inbox, documents review, activity, connections | 0, 2–5 | Done |
| F4 | Home, cash flow, business health | 6 | Drafted |
| F5 | Recommendations, financing, Ask (chat) | 7 | Drafted |
| F6 | Interaction features and end-to-end journeys | All | Drafted (search, shortcuts dialog) |

"Drafted" means page layouts and data hooks exist but have not been tried against real endpoints. Each stage finishes them: connect to the real API, add tests, check the screens.

Endpoints the drafts expect: `POST /api/search` (search terms stay out of URLs and logs), and each PDF page served as an image at `GET /api/documents/{id}/pages/{n}` (0-based, same access check as the original), because our CSP blocks showing PDFs inside the page.

### F1: Setup, design tokens, app shell, sign-in

- Vite, React, TypeScript, Tailwind and shadcn/ui, with versions pinned; dev proxy to the API.
- Design tokens (light and dark), Inter self-hosted, tabular figures.
- Left menu (shown by permission), top bar, side panel and focused panel; phone layout.
- Sign-in, two-step setup (QR code) and code entry; friendly error messages.
- A placeholder for each page.

### F2: Shared components and test setup

- Money (pence smaller, privacy mode), approval badge, confirmation card, AI label with "What the AI saw", empty, loading and error states, number count-up, status dot, initials, help hints, chart with table view.
- Vitest tests for each component; Playwright set up with a sign-in journey.

### F3: Inbox, documents, activity, connections (done)

- Types and hooks now match the real routes (`inbox`, `documents`, `activity`, `connections`, `auth`); approval cards use the server's action as it is, including who must approve, `why_not` and `can_undo`.
- Live updates: the shell listens to `/api/events` and refetches only what each kind of event affects, so documents move through their steps on screen and the inbox and connection cards update by themselves.
- Inbox: To review, Needs approval and Done tabs with counts; approve, reject and cancel on the card; "1 of 2 approvals" with the first approver's name; Undo in the toast and on the Done tab for small changes; quick approval (keyboard or ticked rows) only for one-person changes; a notification link opens its action. An approval about a document shows its card above the document.
- Document review: the original on the left (photos as they are; PDF pages from the page-image address, otherwise a link to the original) with found values highlighted; what we read on the right with plain labels; warnings and why it needs a person; corrections send only the changed fields, and saving a document waiting for review sends it for approval; Read it again; sender checks; the processing journey built from the timeline; "What the AI saw" with each AI reading's result. Warnings sit once at the top, above the decision; the card being decided drops reasons that repeat them, and other approvals on the same document fold away. The journey folds to one line once every step went well.
- Documents list with filters (needs a check, waiting, reading), the live step and warnings, `?open=<id>` links, and a simple list on phones.
- Activity: the log in plain words with who acted, filters by who (on the server) and by topic and words, older pages on demand, "Log intact" from the verify endpoint, and CSV download.
- Connections: a card for the email inbox, payment platform, bank and accounting software with status, last sync, what the last sync read and the API's last error; connect, sync, reconnect and disconnect (with a check first); the bills inbox address with copy; balances we read. QuickBooks connects through a plain link to `/connect/quickbooks/start`, and each `?qbo=` result gets its own message before the address is tidied. The bank connects through the sandbox connect endpoint.
- Upload (15 MB, the file types the server accepts; camera photos marked as photos) and My receipts for employees, using the documents endpoints, which return only their own.
- Dev proxy also forwards `/connect/` (anchored, so the `/connections` page stays with the app).
- Not done: the in-app photo with jscanify (phones use the camera through the file picker for now); Plaid Link (there are no Link start and exchange endpoints yet).
- Tests: 41 new Vitest tests (inbox, documents and review, activity, connections, my receipts), shared fixtures copied from the API's shapes; 76 frontend tests pass. Checked in the browser against the running API at desktop and phone widths, light and dark. Bugs found in that check: the `/connect` proxy rule caught the `/connections` page, QuickBooks result messages were lost on a fresh page load, and long account names pushed the phone layout off screen.

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
