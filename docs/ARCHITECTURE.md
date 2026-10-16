# Architecture

This document shows how our system fits together and how data moves through it. For what the app does, see [Project scope](SCOPE.md). For how each step works, see [Core algorithms](ALGORITHMS.md). For how we protect data, see [Security](SECURITY.md).

## The big picture

![The big picture](diagrams/system-overview.png)

Money data flows in from the business's own tools. We clean and organise it, and the owner gets forecasts, warnings and answers. The AI only ever sees text with personal details removed, and it keeps nothing.

## Where the data comes from

Our app connects to **types** of tools, not to one brand. Each type has a connector that translates the tool's data into one common format, so supporting a new brand (for example PayPal or Xero) means adding one connector.

| Type | Needed? | What it tells us | Examples | In our demo |
|---|---|---|---|---|
| Email inbox | Required | Bills, receipts, payment notices | Gmail, Outlook, any IMAP mailbox | Mailpit test inbox |
| Payment platform | Optional | Money customers paid | Stripe, PayPal, Square | Stripe sandbox (UK, GBP) |
| Bank account | Optional | Money in and out of the bank | A live bank connection such as Plaid, or a statement file (CSV/OFX) | Plaid test bank; statement upload also supported |
| Accounting software | Optional | The official books | QuickBooks, Xero | QuickBooks test company |
| Upload or photo | Always available | Any PDF, image or spreadsheet; a photo taken in the app | — | Built in |

**How email arrives.**
- **Demo:** Mailpit tells our app the moment each email arrives.
- **Production:** the business forwards bills to a dedicated inbox, which we read over IMAP (the standard way to read any mailbox) and which tells us as soon as new mail arrives.
- **Either way:** each email is processed only once, tracked by its unique message ID.

## How a document is processed

![How a document is processed](diagrams/ingestion-graph.png)

1. **Safety check.** We confirm the document really came from the connected source, check it isn't a duplicate, and check the file is safe to open.
2. **Locked archive.** We store the original exactly as received.
3. **Read the text.** Our own server reads the words from the PDF or photo. No AI is involved yet.
4. **Hide personal details.** Names, bank and card numbers and similar details are swapped for placeholders such as `[BANK_ACCOUNT_1]`.
5. **Final privacy check.** If anything personal is left, nothing is sent and a person takes over.
6. **AI fills in a form.** The AI records who, what, how much and when. It cannot take any action.
7. **Do the numbers add up?** Our code checks the totals and that every figure appears in the document.
8. **Try again.** We retry once, then a second AI gives an independent opinion. If the two disagree, a person decides.
9. **Match it.** We link the document to its payment or bank record. If we are not sure, a person decides.
10. **Update the books.** Once approved, the entry goes into the accounting software with the original attached.

## How the assistant answers a question

![How the assistant answers](diagrams/copilot-graph.png)

The assistant answers questions about the business, such as how it is doing, what cash flow looks like, or who pays late. It looks up facts from our records, never from raw documents, and fact-checks its numbers before answering. It can suggest actions, but anything that matters waits for a person's approval (see [Security](SECURITY.md)).

## How recommendations are made

![How recommendations are made](diagrams/insights-graph.png)

A recommendations agent reviews the business's records whenever new data arrives and once a day. Our code finds the facts, such as a supplier's changed address or a price rise. The AI only turns those facts into plain words, and its numbers are fact-checked. Any next step it suggests goes through approval (see [Core algorithms](ALGORITHMS.md), section 9).

## Checking our work

Anyone with permission can compare any extracted record with its original document.

- **Original kept safe:** every original document and email is kept unchanged in an encrypted archive. This is our master copy.
- **Copy in the books:** approved bills and receipts are also attached in the accounting software.
- **Optional Google Drive copy:** a tidy folder copy, for example `Company / 2026 / October / Bills`. We can only see the files we put there.
- **Side-by-side view:** the original sits next to what we extracted, with each value highlighted where it was found.
- **Corrections kept:** every human correction is saved alongside the AI's original answer.

## Technology

| Part | Technology |
|---|---|
| App (what users see) | TypeScript, React, shadcn/ui, Tailwind CSS, Lucide icons, Motion (animation) |
| Server | Python, FastAPI |
| AI workflow | LangGraph (the three workflows above) |
| AI model | Not tied to one model. All requests go through OpenRouter, limited to providers that don't keep or train on our data. A second, different model gives the independent opinion. |
| Reading documents | PyMuPDF, Tesseract OCR, Microsoft Presidio (personal-detail detection) |
| In-app scanner | Phone camera in the browser, jscanify (page detection and straightening) |
| Analysis and recommendations | pandas and numpy (calculations), RapidFuzz (comparing names, addresses and bill lines), phonenumbers (standard phone format) |
| Scheduled checks | APScheduler (daily recommendations run) |
| Charts | Recharts |
| Lender pack | ReportLab (PDF) |
| Security | argon2-cffi (password storage), pyotp (two-step sign-in), python-magic (checking file types by content), pip-audit and npm audit (dependency scanning) |
| Storage | Postgres database (including the business profile and financing catalog), MinIO encrypted file archive |

## Key terms

- **Ledger:** our single record of all money in and out.
- **Reconciliation:** matching each payment to the invoice or bill it belongs to.
- **OCR:** reading text from a photo or scanned page.
- **IMAP:** the standard way to read emails from any mailbox.
- **Sandbox / test mode:** a safe practice version of a service with fake money and data.
- **Placeholder:** a stand-in such as `[BANK_ACCOUNT_1]` that hides a real value from the AI.
