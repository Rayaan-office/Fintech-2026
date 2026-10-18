# Build stages

We build one stage per working session, then test, commit and merge it before starting the next.
Every stage ends with its tests passing in `tests/` (see [tests/README.md](tests/README.md)).
Backend stages are numbered 0–9; frontend stages F1–F6 follow the backend stage whose API they use.

## Backend stages

| Stage | What | Status |
|---|---|---|
| 0 | Foundation and document pipeline | Done |
| 1 | Frontend: see stages F1–F6 below | F1–F5 done; F6 drafted |
| 2 | Email inbox connector (Mailpit) | Done |
| 3 | Payment platform connector (Stripe) | Done |
| 4 | Bank connector (Plaid) | Done |
| 5 | Accounting connector (QuickBooks) | Done |
| 6 | Ledger, matching, forecast and analysis | Done |
| 7 | Approvals, recommendations, financing and assistant | Done |
| 7b | Learning from decisions, getting paid, ask anything | Done |
| 8 | Frontend: see stages F3–F6 below | F3–F5 done; F6 drafted |
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

## Stage 7: Approvals, recommendations, financing and assistant (done)

- AI wording, fact-checked (`copilot/wording.py`), shared by everything below:
  - the AI sees facts as short labelled lines, with suppliers and customers as stable placeholders and any other personal detail hidden;
  - money in the answer must be money from the facts, and a percentage a percentage from the facts; every placeholder must be one we sent;
  - one rewrite, told what was wrong; after that, or while AI is paused, our plain template is shown.
- Recommendations agent (`analytics/rules.py`, `copilot/insights.py`, a LangGraph workflow):
  - five rules: supplier details changed (bank details: urgent, never muted), price rise (by bill and by price per unit), slow payer (including getting slower), spending creep (including a new monthly charge), reliance on one customer;
  - ranked, repeats removed, muted kinds skipped, findings that no longer hold resolved;
  - runs after each sync that brings changes, after a document is approved, once a day, and on request;
  - the next step drafts an email (AI-worded, fact-checked) that waits for approval, sent to the address on record, or the one before a change.
- Why cash changed and the financing summary are now worded by the AI from the numbers and checked; the same facts give the same words without asking again.
- Financing (`analytics/financing.py`, `data/financing_catalog.json`):
  - business profile: automatic values from our records, the owner's corrections kept next to them, and details only the owner adds;
  - 11 sample products; eligibility with near misses ("available after 18 more months of trading");
  - the need from the forecast (shortfall plus 5%) or an amount the owner types in; cost at the middle of the rate range, with the range; repayments run through the forecast;
  - ranked: free first, then those that keep cash above the safety level, by cost; readiness checklist.
- Lender pack (`analytics/lender_pack.py`): a PDF with the profile, 12 months of profit and loss, unpaid invoices, the forecast and the readiness checklist. Downloading is open to finance managers and owners. Sharing stores the PDF and creates an outside action; a business owner approves, and exactly that PDF is emailed.
- Chat assistant (`copilot/assistant.py`, `copilot/tools.py`, a LangGraph workflow):
  - eight read-only tools, at most three per question, run in a transaction Postgres keeps read-only;
  - tools the role doesn't allow are left out (financing for bookkeepers), and off-topic questions are declined;
  - every figure checked against the tool results, then the figures shown plainly if the AI still gets one wrong;
  - charts, tables and sources come from our code;
  - a suggested reminder or supplier email becomes a draft only when clicked;
  - conversations are private to each person.
- API:
  - `/api/recommendations` (list, refresh, dismiss, next step);
  - `/api/financing`, `/api/financing/quote` and `/api/business-profile` (owners edit);
  - `/api/lender-pack.pdf` and `/api/lender-pack/share`;
  - `/api/ask`, `/api/ask/threads` and `/api/ask/messages/{id}/act`.
- Live check against the real AI on the dev company:
  - all 6 recommendations were worded by the AI and passed the fact check, including the fraud drill (urgent) and Acme's flour at £45.00 → £53.10 (+18%);
  - the assistant answered who owes the most, whether Acme raised prices, why cash changed and whether a £18,000 van is affordable;
  - the financing summary found the £2,495 dip on 2 December and the free option that covers it.
- Tests: 68 new, 349 backend tests pass.
  - The integration tests run on the demo story: the rules find exactly its built-in patterns and nothing else, with figures checked against the story. They also cover the agent, financing and the lender pack, and the assistant's tool limits, roles and private threads.
  - Also: unit tests (fact check, financing maths), isolation tests and 8 regression tests.
- Bugs fixed:
  - the same address read differently was raised as a change;
  - one bill's bank and email changes were raised twice;
  - one bill at the new price hid Acme's price rise;
  - profile labels ("Good") crashed matching;
  - repayments fell inside the shortfall, and borrowing exactly the gap fell short by the interest;
  - the fact check took a date's "1" as £1.00;
  - CloudDesk's small creep fell under a £30 floor;
  - getting slower was diluted by older invoices.
- Found in the live check: the AI ran out of room before answering (token allowance raised), and "Acme" in a question wasn't hidden (a short name now becomes its placeholder, or both placeholders when two suppliers share it).

## Stage 7b: Learning from decisions, getting paid, ask anything (done)

- Learning from decisions (`copilot/learning.py`, `api/learning.py`):
  - corrections are kept beside the AI's original answer and the supplier; after 2 matching corrections on approved documents we fill the value in next time (category, type, currency, payment terms, supplier name), marked "Filled from your past corrections" with Undo;
  - recommendations are ordered by Thompson sampling on how often each kind is acted on or turned down, only within the same severity; urgent items and changed bank details never move down; a kind rarely acted on is folded under "Less useful to you", never hidden;
  - bank details, contacts and amounts are never learned; a business owner can reset any of it; the "What we've learned" page shows it all with its numbers.
- Getting paid faster and for less (`analytics/getting_paid.py`, `analytics/methods.py`, `copilot/reminders.py`, `connectors/payment_links.py`, `api/payments.py`):
  - how each payment was made (card, bank transfer, international transfer, cash) from the payment platform and the bank feed;
  - payments that arrive short are recorded; the leftover is never chased and can be recorded as a bank charge after approval;
  - per customer: what each way of paying lost or cost and how long it took, and the saving from paying by card;
  - reminders in three steps (friendly, firm, final notice); a final notice needs a business owner; a card payment link is made only after approval, with a sandbox key that can only create payment links.
- Ask anything (`copilot/tools.py`, `copilot/passages.py`):
  - a query tool: totals, counts or averages by month, category or customer and supplier, built by our code from fixed choices, never SQL from the AI;
  - document search (Postgres full-text) returning short passages with personal and bank details removed and names as placeholders.
- Tests: 133 new, 483 backend and 156 frontend tests pass.
- Bugs fixed:
  - a corrected supplier or total on a bill waiting for approval was ignored;
  - a second correction lost the AI's original answer;
  - a payment that arrived short left a leftover that reminders chased, that counted as owed, and that kept the invoice out of payment habits;
  - international transfers that lost a typical bank charge were never matched;
  - a customer could be chased from two cards at once;
  - in the assistant: placeholder numbers clashed across turns, a fallback answer kept personal details in the history, and a document's hidden person could be shown with a name from the question.
- Live check against the real AI on the dev company:
  - reminder cards show their step, invoices and days overdue; an approved friendly reminder to Corner Deli reached the mailbox with a sandbox card link, which opened a checkout for INV-2077 at £300.00, and the step was recorded;
  - the card-or-transfer comparison for Green Leaf Bistro: 17 days sooner by card against £319.89 in fees;
  - document search returned passages with sort codes and the bank's name hidden; totals by category matched.
- Found in the live check: reminders read "invoice from" a customer and "1 days", a cost card left out the customer's name, and money moved between the business's own accounts counted as spending.

## Stage 9: Hardening and submission

pip-audit and npm audit, end-to-end tests, deployment and testing docs, security self-assessment, execution evidence (activity log and sandbox logs), deck and demo video.

## Frontend stages

| Stage | What | Uses backend stage | Status |
|---|---|---|---|
| F1 | Setup, design tokens, app shell, sign-in and two-step | 0 | Done |
| F2 | Shared components and test setup | 0 | Done |
| F3 | Inbox, documents review, activity, connections | 0, 2–5 | Done |
| F4 | Home, cash flow, business health | 6 | Done |
| F5 | Recommendations, financing, Ask (chat) | 7 | Done |
| F6 | Interaction features and end-to-end journeys | All | Search, shortcuts, journeys and design pass done; the rest to do |

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

### F4: Home, cash flow, business health (done)

- Types and hooks now match the Stage 6 routes (`home`, `cash`, `cash-flow`, `cash-flow/what-if`, `cash-flow/why`, `planned-items`, `business-health`). Dates the server sends as calendar days are read as that day wherever the person is.
- Home: greeting and quick buttons (upload, Ask, plan a cost). The Today briefing puts the most pressing items first, each with its next step; more than four fold behind "Show more". Cash today says how many accounts it covers and which ones in another currency it leaves out, with the next 30 days, the balance in 30 days and the lowest point in 90. Three cards: bills due this week (or when the next one is due), who owes you with what's overdue (opens that chart on Business health), and recommendations with the most urgent one named and opened directly. Nothing connected yet shows how to start.
- Cash flow: the lowest point and whether it stays above the safety level, then the balance in 7, 30, 60 and 90 days. The forecast has the best-to-worst band, markers for money going out (named in the tooltip) and the safety level, which stays in view even when cash is below it every day. Unpaid bills sit on a strip lined up with the chart's days: drag one to another day, or use the arrow keys, and we ask for the what-if once the person stops. Any payment can be switched off. The what-if bar shows the new lowest point next to the old one, the chart shows the forecast before the changes as a dashed line, and Reset or "Put back" undo it; nothing is saved. Plan a cost (once, weekly or monthly) is tried out first; people who can use financing can keep it in everyone's forecast and remove it later. Warnings say why, and the expected-case ones link to financing. "Why cash changed" (this month or the last 30 days) shows the AI's explanation with "What the AI saw" when the AI wrote it, our own sentence otherwise, and the reasons with their amounts.
- Business health: profit and margin for the last three full months, days to get paid and runway, each saying when there is nothing to measure yet instead of showing 0. One chart switches between profit by month, spending by category, biggest suppliers and who owes you (`?view=` keeps the choice); every view has a table, and long names get bars across. Health checks with why each one shows.
- Live updates: a sync, a match or an approval now refreshes Home, cash flow, business health and financing too.
- Tests: 33 new Vitest tests (cash flow 11, Home 8, business health 8, dates 3, live updates 2, chart 1) with fixtures copied from the API's shapes; 131 frontend tests pass, with typecheck and build.
- Bugs found and fixed, each with a regression test: calendar days showed as the day before west of London; after a sync, a match or an approval the money screens kept the old numbers until a reload; a missing "days to get paid" showed as "0 days" and no sales as a 0% margin; the Home chart was called "Next 90 days" over the 31 days the server sends; the safety level dropped out of the chart when cash stayed below it every day.
- Not checked in the browser yet; that happens with the merge.

### F5: Recommendations, financing, Ask (done)

- Types and hooks now match the Stage 7 routes (`recommendations`, `financing`, `business-profile`, `lender-pack`, `ask`). Wording from the server shows the AI label and "What the AI saw" only when the AI wrote it; our own template shows as plain text.
- Recommendations: cards with severity, money at stake, the AI summary and "Why am I seeing this?"; the side panel shows the evidence before and after, and links to approvals already waiting about changed bank details. The next step drafts the email and opens its confirmation card, which can be approved there; a draft already waiting opens again, and a sent one says so. Steps without an email link to the page that helps. Dismiss offers "this one" or "this kind for this supplier"; changed bank details have one Dismiss that never mutes. "Check now" runs the checks and says what changed. `?open=<id>` opens one (Ask's sources link here).
- Financing: the gap headline (how far below the safety level, from when, for how long, and the amount we cost options for), the checked summary, options that fit (free first, then by cost, each with its total, monthly cost and whether cash stays above the safety level), and near misses with what would change. Each option opens a side panel with amount and length sliders that call the quote endpoint (debounced), with the cost, its range, the yearly rate, the forecast effect and a chart of cash with and without it. Owners can compare for their own amount, length and purpose. Readiness checklist with tips. Business profile with each correction next to its automatic value; owners edit what only they know and correct or reset automatic values. Lender pack: download the PDF, or share it, which prepares the pack and shows the approval card (a business owner approves).
- Ask: answers with charts and tables built from the blocks (every chart has a table view), sources as links, follow-up options on the latest answer, and the suggested email as a button that drafts it and shows its approval card in the chat. Earlier conversations in a side list (a panel on phones), continued with their thread. Voice input kept from the draft.
- Live updates: `recommendations` and `forecast` events now refresh their screens.
- Tests: 22 new Vitest tests (recommendations 9, financing 8, Ask 5) with fixtures copied from the API's shapes; 98 frontend tests pass, with typecheck and build.
- Checked in the browser against the running API at desktop and phone widths, light and dark. Bugs found in that check: long next-step buttons pushed the side panel and the phone layout sideways, the "with this option" line stopped after a few days because its draw-in animation was cut short by re-renders, the newest question sat under the question box, and the question box hint was cut off on phones.
- Backend gaps found (not fixed): the quote endpoint starts the money tomorrow, while the options list starts it the day before the gap, so a card can say "keeps cash above your safety level" while the sliders at the same amount say it still drops; earlier conversations don't keep "What the AI saw" (the thread endpoint returns it empty).

### F6: Interaction features and end-to-end journeys (search, shortcuts and journeys done)

- Search everything (Ctrl/⌘ K, `api/search.py`): customers, suppliers, invoices and bills (by number or amount), documents, open recommendations and approvals waiting, best match first. The search goes in the request body, never in an address or a log; results link by id and never show bank or contact details.
- Each PDF page is shown as a picture (`/api/documents/{id}/pages/{n}`), with the same access check as the original, so the review view shows the bill with the fields the AI read marked on it.
- Keyboard shortcuts and the `?` dialog.
- Browser journeys (Playwright) run a second copy of the app on its own ports and its own database, filled with the demo story by `tests/e2e/seed.py`, so they never touch development data. The AI and the mailbox are the real ones. 7 journeys pass:
  - a bookkeeper signs in without two-step; an owner sets up two-step and passes it;
  - a bookkeeper uploads a bill, the AI reads it, an owner approves it, and the activity log shows every step, including that personal details were hidden before the AI read the bill;
  - fraud drill: the same supplier's bill with new bank details is flagged in the inbox and leads the recommendations, marked urgent;
  - what-if: moving a bill shows the new lowest point and changes nothing;
  - ask: an answer from the records, where "What the AI saw" has placeholders, not the customers' names;
  - keyboard: `?` lists the shortcuts, and search finds a bill and opens it, without the search in the address.
- Tests: 46 new backend tests (search, page pictures, isolation and roles), 4 new frontend tests; 530 backend and 160 frontend tests pass.
- Bugs found by the journeys:
  - `?` never opened the shortcuts dialog (it listened for "?" without Shift);
  - on a new business, the run after an upload and "Check now" both added the same new recommendations, so "Check now" failed.
- Design pass on every screen, modelled on a leading business bank's demo:
  - Light by default (dark stays a choice in Settings).
  - Flat sections in place of boxed cards.
  - Each page opens on its headline numbers, at most one chart and the next step. Explanations, AI paragraphs, evidence and long lists sit behind a click, a fold, a pop-up or a side panel.
  - Charts are used only where they answer better than a number:
    - lines for cash over time;
    - bars for profit by month;
    - a donut for spending by category;
    - share bars for suppliers and customers.
  - Shared building blocks in `components/kit.tsx`.
  - Rows with a fraud warning can no longer be bulk-approved or approved with a single key; they always open the full approval card.
  - Charts no longer animate in, which could leave them empty in a background tab.
  - Tests: 14 new frontend tests; 174 frontend tests and all 7 journeys pass.
- Brand: the app is now **Cocent** ("every cent, with your consent"). The logo is in the sidebar, the sign-in page and the phone page; the browser tab, home-screen icons and the two-step sign-in entry use it too. The accent colour moved to the logo's violet. The story behind the name is in the README.
- After the design pass:
  - Phone upload works. The "Use your phone" button called a server endpoint that was never built (`api/handoff.py` is new):
    - The QR code's link works for 10 minutes and up to 10 photos, for the person who made it.
    - The link is stored only as a fingerprint.
    - Photos go through the same safety checks as any upload, and arrive in the dialog on the computer as they land.
    - In development the link uses the computer's Wi-Fi address, since a phone can't open "localhost", so the phone must be on the same Wi-Fi.
  - Ask: you can delete your own conversations. The activity log records that a conversation was deleted, never what was said. Example questions now go into the box to edit or send, instead of sending straight away.
  - Recommendations is in the sidebar. Each row has one short "Take action" button that opens a card saying exactly what will happen, then a short confirm ("Draft email", "Record charge", "Go to cash flow").
  - Cash flow: "Move a bill" is now a tidy list, one row per bill in date order, each with who, how much and a date handle on a 90-day line, plus a way to put it back.
  - Bug: the financing list timed the money to arrive the day before cash dips, but an option's detail panel started it tomorrow. An overdraft's repayment then fell inside the dip, so the list said "Covers it" while its own panel showed cash below the safety level. Both now use the same rule, and the panel says when the money arrives.
  - Bug, found by the browser journeys: when the AI's answer failed our check we showed our own figures but hid "What the AI saw", though the question and figures (names hidden) had been sent. It now shows whenever something went to the AI.
  - The browser journeys that wait on the real AI get up to 3 minutes per AI step.
  - Tests: 10 new backend tests (phone upload, deleting conversations, financing list and panel agree), 5 new frontend tests; 540 backend and 179 frontend tests and all 7 journeys pass.
- Still to do: swipe review on phones, show your work (click a number to open its source), Today briefing read aloud, reduce-motion check, accessibility pass.
