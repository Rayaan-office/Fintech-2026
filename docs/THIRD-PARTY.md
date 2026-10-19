# Third-party services, software and attribution

Cocent is built on the work of others. This page lists every outside service we connect to, every program we run alongside our own, and every library our code uses directly, with its licence. We thank all of their authors.

Each component stays under its own licence or terms. Our own work is covered by our [licence](../LICENSE). The complete lists of indirect dependencies, with exact versions, are in the lock files: `backend/uv.lock`, `frontend/package-lock.json` and `tests/e2e/package-lock.json`.

Names such as Stripe, Plaid, QuickBooks, Intuit, OpenRouter, Docker and GitHub are trademarks of their owners. We use them only to say which services our demo connects to. Cocent is not affiliated with or endorsed by any of them.

## Outside services

All of them are used in test (sandbox) mode with made-up data. No real money moves.

| Service | What we use it for | Terms |
|---|---|---|
| [OpenRouter](https://openrouter.ai) | The AI gateway: one key for many AI models, limited to providers that keep nothing and don't train on our data | [OpenRouter terms](https://openrouter.ai/terms) |
| AI models reached through OpenRouter | Reading documents into a fixed form, and wording findings and answers in plain English | Each model provider's terms, as listed on OpenRouter |
| [Stripe](https://stripe.com) sandbox | The payment platform: card sales, fees, refunds, disputes, payouts, and card payment links in reminders | [Stripe services agreement](https://stripe.com/legal/ssa) |
| [Plaid](https://plaid.com) sandbox | The bank account: transactions and balance from Plaid's UK test bank | [Plaid developer policy](https://plaid.com/legal/) |
| [Intuit QuickBooks Online](https://developer.intuit.com) sandbox | The accounting software: customers, suppliers, invoices, bills and payments, and adding approved bills | [Intuit developer terms](https://developer.intuit.com/app/developer/qbo/docs/legal-agreements) |
| [GitHub](https://github.com) | Hosting this repository | [GitHub terms of service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) |

## Programs we run alongside our code

| Program | What we use it for | Licence |
|---|---|---|
| [PostgreSQL](https://www.postgresql.org) 17 | The database, with row-level security to wall businesses off | PostgreSQL Licence |
| [SeaweedFS](https://github.com/seaweedfs/seaweedfs) | Storage for the encrypted original documents | Apache-2.0 |
| [Mailpit](https://github.com/axllent/mailpit) | The test email inbox | MIT |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | Reading text from photos and scanned pages | Apache-2.0 |
| [libmagic](https://www.darwinsys.com/file/) | Checking what a file really is from its content | BSD-2-Clause |
| [Docker](https://www.docker.com) | Running the database, storage and inbox on one computer | Docker's terms |
| [Stripe CLI](https://github.com/stripe/stripe-cli) | Passing payment-platform notifications to a computer without a public address | Apache-2.0 |
| [uv](https://github.com/astral-sh/uv) | Installing and running the Python server | MIT or Apache-2.0 |
| [Node.js](https://nodejs.org) | Building and running the app | MIT |

## Server libraries (Python)

| Library | What we use it for | Licence |
|---|---|---|
| [FastAPI](https://github.com/fastapi/fastapi) | The web server's API | MIT |
| [Uvicorn](https://github.com/encode/uvicorn) | Running the API | BSD-3-Clause |
| [SQLAlchemy](https://www.sqlalchemy.org) | Talking to the database with safe, parameterised queries | MIT |
| [psycopg](https://www.psycopg.org) | The PostgreSQL driver | LGPL-3.0 |
| [Pydantic](https://github.com/pydantic/pydantic) and [pydantic-settings](https://github.com/pydantic/pydantic-settings) | Checking every input, output and AI answer against a fixed shape; reading settings | MIT |
| [python-multipart](https://github.com/Kludex/python-multipart) | Receiving uploaded files | Apache-2.0 |
| [argon2-cffi](https://github.com/hynek/argon2-cffi) | Storing passwords safely | MIT |
| [PyOTP](https://github.com/pyauth/pyotp) | Two-step sign-in codes | MIT |
| [cryptography](https://github.com/pyca/cryptography) | Encrypting documents, personal details and connection keys | Apache-2.0 or BSD-3-Clause |
| [HTTPX](https://github.com/encode/httpx) | Calls to outside services, with time limits | BSD-3-Clause |
| [stripe-python](https://github.com/stripe/stripe-python) | The payment platform connector | MIT |
| [plaid-python](https://github.com/plaid/plaid-python) | The bank connector | MIT |
| [boto3](https://github.com/boto/boto3) | Talking to the document storage | Apache-2.0 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | The three AI workflows: reading documents, recommendations and the assistant | MIT |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | Reading text from PDFs and drawing page pictures | AGPL-3.0 or Artifex commercial licence (see the note below) |
| [pytesseract](https://github.com/madmaze/pytesseract) | Calling Tesseract | Apache-2.0 |
| [Pillow](https://github.com/python-pillow/Pillow) | Preparing photos for reading | MIT-CMU |
| [Microsoft Presidio](https://github.com/microsoft/presidio) (analyzer and anonymizer) | Finding and hiding people's names and places before text reaches the AI | MIT |
| [spaCy](https://github.com/explosion/spaCy) and its [en_core_web_lg](https://github.com/explosion/spacy-models) model | The language model Presidio uses to recognise names | MIT |
| [python-magic](https://github.com/ahupp/python-magic) | Calling libmagic | MIT |
| [pandas](https://pandas.pydata.org) and [NumPy](https://numpy.org) | Forecasts and business-health calculations | BSD-3-Clause |
| [RapidFuzz](https://github.com/rapidfuzz/RapidFuzz) | Comparing names, addresses and bill lines | MIT |
| [phonenumbers](https://github.com/daviddrysdale/python-phonenumbers) | Recognising phone numbers in any format | Apache-2.0 |
| [python-stdnum](https://arthurdejong.org/python-stdnum/) | Checking bank, VAT and company numbers by their check digits | LGPL-2.1 or later |
| [APScheduler](https://github.com/agronholm/apscheduler) | Reading the bank and accounting software on a schedule | MIT |
| [ReportLab](https://www.reportlab.com) | The lender pack PDF, and the demo's sample bills | BSD |
| [sse-starlette](https://github.com/sysid/sse-starlette) | Live updates on screen | BSD-3-Clause |
| [openpyxl](https://openpyxl.readthedocs.io) | Reading uploaded spreadsheets (values only, never formulas or macros) | MIT |
| [dnspython](https://www.dnspython.org) | Looking up senders' email records | ISC |
| [dkimpy](https://launchpad.net/dkimpy) | Checking email signatures (DKIM) | BSD-style |
| [pyspf](https://github.com/sdgathman/pyspf) | Checking which servers may send for a domain (SPF) | Python Software Foundation Licence |
| [qrcode](https://github.com/lincolnloop/python-qrcode) | Installed with the server; the app draws its QR codes in the browser instead | BSD |

## App libraries (JavaScript)

| Library | What we use it for | Licence |
|---|---|---|
| [React](https://github.com/facebook/react) | The app's screens | MIT |
| [React Router](https://github.com/remix-run/react-router) | Moving between pages | MIT |
| [TanStack Query, Table and Virtual](https://github.com/TanStack) | Loading data, tables and long lists | MIT |
| [Radix UI](https://github.com/radix-ui/primitives) | Accessible dialogs, menus and controls | MIT |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | Starting point for our buttons, cards and dialogs (copied into `frontend/src/components/ui`) | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [tailwind-merge](https://github.com/dcastil/tailwind-merge), [class-variance-authority](https://github.com/joe-bell/cva), [clsx](https://github.com/lukeed/clsx) and [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | Styling | MIT (class-variance-authority: Apache-2.0) |
| [Recharts](https://github.com/recharts/recharts) | Charts | MIT |
| [Motion](https://github.com/motiondivision/motion) | Gentle animation | MIT |
| [cmdk](https://github.com/pacocoursey/cmdk) | Search everything (Ctrl or ⌘ K) | MIT |
| [react-hotkeys-hook](https://github.com/JohannesKlauss/react-hotkeys-hook) | Keyboard shortcuts | MIT |
| [Sonner](https://github.com/emilkowalski/sonner) | Short messages such as "Approved, Undo" | MIT |
| [qrcode.react](https://github.com/zpao/qrcode.react) | The QR codes for two-step sign-in and for uploading from a phone | ISC |
| [Lucide](https://github.com/lucide-icons/lucide) | Icons | ISC |
| [Inter](https://github.com/rsms/inter), through [Fontsource](https://github.com/fontsource/font-files) | The typeface | SIL Open Font Licence 1.1 |
| [Vite](https://github.com/vitejs/vite) | Building the app and the development server | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Type checking | Apache-2.0 |

## Testing and checking tools

| Tool | What we use it for | Licence |
|---|---|---|
| [pytest](https://github.com/pytest-dev/pytest) and [pytest-asyncio](https://github.com/pytest-dev/pytest-asyncio) | Server tests | MIT, Apache-2.0 |
| [Vitest](https://github.com/vitest-dev/vitest), [Testing Library](https://github.com/testing-library) and [jsdom](https://github.com/jsdom/jsdom) | App tests | MIT |
| [Playwright](https://github.com/microsoft/playwright) | Browser journeys | Apache-2.0 |
| [pip-audit](https://github.com/pypa/pip-audit) and npm audit | Checking dependencies for known security problems | Apache-2.0, Artistic-2.0 (npm) |
| [Ruff](https://github.com/astral-sh/ruff) | Python style checks | MIT |
| [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) | Drawing the diagrams in these documents | MIT |

## Data

- **Demo data** is made up by us (`backend/app/demo/story.py`). Every business, person, address and bank detail in it is fictional.
- **Financing options** in `backend/app/data/financing_catalog.json` are sample products with sample rates, not offers from real lenders.
- **No real customer data** is used anywhere in this repository.

## Licence notes

- **PyMuPDF** is offered under the GNU AGPL-3.0, or under a commercial licence from Artifex. For this competition entry we publish our full source code. Before any commercial use we would either buy the commercial licence or replace PyMuPDF with a permissively licensed PDF reader.
- **psycopg** and **python-stdnum** (LGPL) are used as unmodified libraries.
- **certifi**, **orjson** and **tqdm** (server) and **lightningcss** (app build), all MPL-2.0 in whole or part, are indirect dependencies used unmodified.
- **caniuse-lite** (CC-BY-4.0) is used only while building the app. Its data comes from [caniuse.com](https://caniuse.com).
- We checked every direct and indirect dependency's licence. Apart from those listed above, all are permissive (MIT, BSD, ISC, Apache-2.0 and similar).
