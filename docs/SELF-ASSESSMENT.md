# Security self-assessment

This is our honest check of Cocent's security against our own design in [Security](SECURITY.md): what is built, how it is enforced, how we tested it, and what is still missing. Every row points to the code or the test that backs it up. Test files are under `tests/backend/`, and the browser journeys are listed in [Testing](TESTING.md).

**In short:** the approval levels, the walls between businesses, hiding personal details from the AI and the tamper-evident log are built and tested. Gaps that remain are listed openly at the end, with how we would close each one.

## 1. Approval levels as built

Every action Cocent can take has a fixed level in our server code (`backend/app/security/rbac.py`). The AI can propose actions but cannot change their level, and the server checks the level and the person's role before anything runs (`backend/app/actions.py`).

| Level | Actions in the app | Who can approve | How it is enforced | Tested by |
|---|---|---|---|---|
| 0 · Read | Records, forecasts, analysis, explanations, warnings | Anyone allowed to see them | Every request checks the person's business and role | `security/test_tenant_isolation.py`, `security/test_auth.py` |
| 1 · Suggest | Draft a bill, suggest a match, raise a recommendation, draft an email | Nobody: it waits in the Inbox | Suggestions are only saved, never carried out | `integration/test_recommendations.py` |
| 2 · Small change | Approve a read document, accept a match, record a bill, record a bank charge | One person. A bill is automatic if small, confident, from a known supplier, with no warnings and AI not paused. A bank charge needs a finance manager or owner and is never automatic. | Automatic only when every condition holds; can be undone | `integration/test_ingestion.py`, `integration/test_getting_paid.py` |
| 3 · Outside action | Add a bill to the accounting software, email a customer or supplier, share the lender pack | One person with the right role. A final payment notice and the lender pack need a business owner. | Server check on role; emails go only to the address on record | `integration/test_accounting_software.py`, `integration/test_email_inbox.py`, `security/test_getting_paid_security.py` |
| 4 · Two people | Change a supplier's bank details | Two different people, each an owner or finance manager. The person who prepared it cannot approve it. | Two approvals recorded by different people; refusals are logged | `integration/test_ingestion.py` (fraud drill needs two people), `security/test_learning_security.py`; the preparer rule is in `backend/app/actions.py` (no dedicated test yet) |
| Never | Manage users, change limits, see hidden personal details, move money | Not available to the AI | Refused before any action is created | `backend/app/actions.py` (no dedicated test yet) |

### Roles as built

| Role | Can approve | Cannot |
|---|---|---|
| Business owner | Everything, including final notices and sharing the lender pack; Pause AI | — |
| Finance manager | Level 2 and 3 actions, and level 4 as one of two people; connect tools; financing | Final notices, sharing the lender pack, Pause AI |
| Bookkeeper | Read documents, matches, bills, reminders and supplier emails | Bank-detail changes, bank charges, final notices, connecting tools, financing |
| Employee | Nothing: sends in receipts and sees only their own | Anything else |

Owners, finance managers and any named second approver must use two-step sign-in (`security/test_auth.py`).

## 2. Our checklist

| Area | What we check | Status | Evidence |
|---|---|---|---|
| Walls between businesses | The database itself hides other businesses' rows, even if our code forgot a filter | Done | `security/test_tenant_isolation.py`; separate isolation tests for advice, search, learning, getting paid and the assistant |
| Sign-in | Argon2 passwords, the same answer for unknown emails, lockout after 5 failures, secure cookies, session timeouts | Done | `security/test_auth.py`, `unit/test_crypto.py` (Argon2); session timeouts are set in `backend/app/config.py` (no dedicated test yet) |
| Two-step sign-in | Required for owners and finance managers | Done | `security/test_auth.py`, browser journey 1 |
| Personal details hidden from the AI | Replaced by placeholders before sending; a final scan blocks anything left | Done | `unit/test_redaction.py`, `security/test_ask_privacy.py`, browser journeys 2 and 5 |
| Personal-detail store | Encrypted, readable only through its own database account | Done | `security/test_tenant_isolation.py` (app account cannot read the vault) |
| AI answers checked | Fixed form; totals add up; every figure must appear in the source; a second model when in doubt | Done | `unit/test_wording.py`, `integration/test_ingestion.py` |
| Hidden instructions in documents | The reading AI can only fill a form; document text is marked as data; gateway blocks go to a person | Done | `integration/test_ingestion.py` |
| Fraud warnings | Changed bank details, look-alike senders, duplicates, failed sender checks | Done | `integration/test_ingestion.py`, `integration/test_email_inbox.py`, browser journey 3 |
| Email trust | Our own signature check; only our receiving server's verdict counts; spoofs refused | Done | `integration/test_email_inbox.py` |
| Signed notifications | Payment platform and accounting software notifications must be signed and recent | Done | `integration/test_payment_platform.py`, `integration/test_accounting_software.py` |
| Least access to outside services | Read-only sandbox keys; live keys and live data refused | Done | `integration/test_payment_platform.py`, live sandbox checks |
| Tamper-evident log | Each entry fingerprints the one before; the app account cannot edit it | Done | `unit/test_audit_chain.py`, `security/test_tenant_isolation.py` |
| Web security | Security headers, changes only from our own app's address (look-alike addresses refused), errors reveal nothing | Done | `security/test_http.py`, `regression/test_lookalike_origin_accepted.py` |
| Uploads | Type checked by content, size and page limits, macros refused, read in a time-limited worker | Done | Macros and web pages refused: `integration/test_phone_handoff.py`, `integration/test_ingestion.py`; size, page and time limits (no dedicated test yet) |
| Spreadsheet exports | Cells that could run formulas are neutralised | Done | `unit/test_crypto.py` |
| Outside calls | Only a fixed list of addresses; time limits on every call; no redirects | Done | `backend/app/connectors/outbound.py` (no dedicated test yet). The file archive and outgoing email use their own clients, also with time limits. |
| AI spending | Daily budget, hourly limit per business, answer length cap, one retry | Done | Retries and the provider's budget refusal: `regression/test_ai_temporary_error_not_retried.py`; our own limits (no dedicated test yet) |
| Pause AI | One switch stops every automatic AI action | Done | AI wording falls back to our template: `integration/test_recommendations.py`; automatic approvals stop in `backend/app/actions.py` (no dedicated test yet) |
| Dependencies | No known security problems | Done | pip-audit and npm audit, 20 October 2026: none found |

## 3. Known risks

| Risk | What could happen | How we handle it | What remains |
|---|---|---|---|
| A personal detail is missed | It reaches the AI provider | Two kinds of detection, a final scan, the gateway's second check, providers that keep nothing | Unusual formats may slip through |
| The AI misreads a document | Wrong amount or date | Our checks, a second AI opinion, a person approves | Errors that still look right |
| Hidden instructions in a document | The AI is steered | The reading AI cannot act; every figure is checked against the source | A wrong form answer, caught by the checks |
| Fake bill or changed bank details | Money paid to a fraudster | Fraud warnings and two-person approval | A convincing fraud from a supplier's real, hacked mailbox |
| Stolen connection key | Data read by an attacker | Read-only keys, encrypted at rest, never shown to the AI | Readable until the key is revoked |
| Two approvers working together | A bad change approved | Two-person rule, permanent log | Collusion can't be fully prevented |
| AI provider outage | Documents wait | Only providers that keep nothing; requests fail safe; work resumes | Delays |
| Wrong forecast or recommendation | A poor decision | Best and worst case, evidence shown, presented as information, not advice | Unexpected events |

## 4. Gaps we know about

We would close these before any real use.

| Gap | Today | How we would close it |
|---|---|---|
| No payments | Cocent never pays anyone. The levels for paying a supplier (one person, or two for large or first-time payments, with each finance manager's limit) are in the code but nothing uses them yet. | Connect a payment service behind the same levels |
| Second approver | A business with only one owner can't yet name a trusted second approver in the app | Add a team page for owners to name one, limited to level 4 |
| Rate limits | Per person, plus tighter limits on sign-in, uploads and questions, kept in one server's memory. Approvals have no limit of their own. | A shared store when running more than one server |
| Security alerts | Locked accounts and refused emails notify everyone in the business; refused approvals and gateway blocks are only logged | Send them to the owner, and alert on repeats |
| Key rotation | Keys are kept in settings and encrypted data is labelled with a version, but nothing rotates them yet | Scheduled rotation with re-encryption |
| Deleting a business's data | No self-service deletion | An owner-only deletion that also clears the archive |
| Team and limit screens | Users, roles and the approval limit are set when the business is created; there is no screen to change them | An owner-only team and limits page |
| Cancelling a waiting request | Anyone who can see all records can cancel a waiting action, including a two-person change. Cancelling only stops it; nothing is carried out. | Limit it to the person who asked and to owners |
| Reading a real mailbox | Only the demo inbox is connected; reading a business's own mailbox (IMAP) is not built | Add an IMAP reader feeding the same intake step |
| Test coverage | The rows above marked "no dedicated test yet" are built but not tested on their own | Add a security test for each |
| HTTPS | Our demo runs on this computer without HTTPS; strict HTTPS (HSTS) switches on when the app's address is HTTPS | Serve behind HTTPS in production |
| PDF reader licence | PyMuPDF is AGPL-3.0 | Buy its commercial licence, or replace it, before commercial use (see [Third-party](THIRD-PARTY.md)) |
