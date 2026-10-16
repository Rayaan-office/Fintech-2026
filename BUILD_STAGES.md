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
| 3 | Payment platform connector (Stripe) | Code drafted, partly tested |
| 4 | Bank connector (Plaid) | Code drafted, partly tested |
| 5 | Accounting connector (QuickBooks) | Code drafted, not tested |
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

## Stage 3: Payment platform connector (Stripe)

- Sync customers, invoices, card payments with fees, payouts and balance; signature-checked notifications via `stripe listen --api-key` (sandbox key, never `stripe login`).
- Decide what to do with the existing USD test data in the sandbox (3 customers, 113 payments) and the AED balance: the account is UAE-based, so a UK Stripe account would give GBP throughout.
- Seed GBP customers and invoices from the story.
- Tests: sync mapping, signature checks, replayed events, live contract test.

## Stage 4: Bank connector (Plaid)

- Custom sandbox user generated from the story (266 transactions, GBP), cursor-based sync, expired-connection handling.
- Background schedule for polling.
- Tests: sync mapping, removed transactions, reconnect message, live contract test.

## Stage 5: Accounting connector (QuickBooks)

- Sign-in with Intuit, token refresh, full sync and change-feed polling, signed webhooks.
- Seed the sandbox company from the story (backdated invoices, bills, payments).
- Approved bills posted with the original attached.
- Needs a UK sandbox company so amounts are in GBP.
- Tests: OAuth state, mapping, posting, webhook signature.

## Stage 6: Ledger, matching, forecast and analysis

- Cash position across accounts in the business currency.
- Matching rules and scoring on real synced data, combinations, accept / reject flows.
- 90-day forecast with best and worst case, repeating items, everyday pattern.
- Early warnings, business health, why cash changed, what-if.
- Tests: each calculation against the story's known answers.

## Stage 7: Approvals, recommendations, financing and assistant

- Remaining action handlers: post to accounting, lender pack sharing. (Sending reminders and supplier emails was built in Stage 2; Stage 7 drafts them.)
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
