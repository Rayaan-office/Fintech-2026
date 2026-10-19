# Testing

We test Cocent at four levels, from single calculations up to a person using the app in a real browser. Every bug we fix gets its own test, so it can't come back.

## Results

Last full run: 20 October 2026.

| Level | What it checks | Tests | Result |
|---|---|---|---|
| Unit | Single calculations: hiding personal details, the checks on AI answers, matching scores, forecast maths | 87 | Pass |
| Integration | Whole flows through the API on a real database: sign-in, documents, approvals, every connector, forecasts, recommendations, financing, the assistant | 234 | Pass |
| Security | One business can't see another's data, roles and approval levels, two-step sign-in, security headers, the AI never sees hidden details | 48 | Pass |
| Regression | One test for each bug we fixed | 78 | Pass |
| **Server total** | Including tests that run with several inputs | **541 runs** | **All pass** |
| Live sandbox checks | Our connectors still understand the real Stripe and Plaid sandboxes, and our Stripe key can't change anything | 14 | Pass (see note) |
| App | Every screen and shared component, in a simulated browser | 180 | All pass |
| Browser journeys | A person using the real app end to end, with the real AI | 7 | Pass (see note) |
| Dependency check | Known security problems in every library (pip-audit, npm audit) | All libraries | None found |
| Type check | The app's code and tests | Both | Clean |

**Notes from this run.** One live check failed once because Plaid's sandbox sent only part of the test bank's history, and it passed when run again. One browser journey (the fraud drill) waited more than its 3 minutes once because the AI was slow to word the warning; the warning itself was raised correctly, and the journey passed when run again.

## The browser journeys

They run a second copy of the app on its own ports and its own database, filled with the demo story, so they never touch other data.

1. A bookkeeper signs in with a password only; an owner sets up two-step sign-in and passes it.
2. A bookkeeper uploads a bill, the AI reads it, an owner approves it, and the activity log shows every step, including that personal details were hidden before the AI saw the bill.
3. Fraud drill: the same supplier's bill with new bank details is stopped, flagged in the inbox, and leads the recommendations marked urgent.
4. What-if: moving a bill shows the new lowest cash point and changes nothing.
5. Ask: an answer comes from the records, and "What the AI saw" shows placeholders, not customers' names.
6. Keyboard: `?` lists the shortcuts, and search finds a bill and opens it.

## Bugs our tests caught

A few examples of what the tests found while we built Cocent, each now guarded by a test:

- Correcting the supplier or the total on a bill waiting for approval had no effect on what was then approved.
- Reconnecting a bank doubled every bank transaction.
- Approving a bill again after a failed attempt added it to the accounting software twice.
- Any sender could fake the "this email passed its checks" verdict.
- A payment that arrived a little short (a bank charge on the way) left a leftover that reminders kept chasing.
- A reminder sent late in the evening counted as sent a day earlier in some time zones, so the next reminder came a day early.
- Rows with a fraud warning could be approved in bulk with one key; they now always open the full approval card.

## Run the tests yourself

Start the services first ([Run Cocent yourself](setup/README.md), steps 1 to 3). The tests use their own databases, so your data is never touched.

Server tests:

```bash
cd backend && uv run pytest
```

Live sandbox checks (need the Stripe and Plaid sandbox keys in `.env`):

```bash
cd backend && uv run pytest --live ../tests/backend/contract
```

App tests and type check:

```bash
cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json
```

Browser journeys (need the AI key; they start their own copy of the app):

```bash
cd tests/e2e && npm install && npx playwright install chromium
```

```bash
cd frontend && npm run e2e
```

Dependency checks:

```bash
cd frontend && npm audit
```

```bash
cd backend && uv run pip-audit
```

Where each kind of test lives, and how to add a regression test, is in [tests/README.md](../tests/README.md).
