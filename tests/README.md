# Tests

The latest results, and what the tests caught, are in [Testing](../docs/TESTING.md).

All tests live here, outside the app code, so nothing test-related ships with a deploy.
They use their own database (`copilot_test`), created automatically, so they never touch development data.

| Folder | What it checks | Runs against |
|---|---|---|
| `backend/unit` | Single functions: redaction, checks, matching scores, forecast maths | Nothing outside the function |
| `backend/integration` | Whole API flows: sign-in, documents, approvals, connectors | Test database, archive and Mailpit test inbox in Docker; outside services faked. Email tests are skipped if Mailpit isn't running. |
| `backend/security` | Access between businesses, roles, two-step sign-in, headers, injection, log tampering | Test database |
| `backend/regression` | One test for every bug we fix, named after the bug, so it can't come back | As needed |
| `backend/contract` | Our connectors still understand the real sandbox responses | Real sandboxes, only with `--live` |
| `frontend` | Components and screens (Vitest) | Browser simulation |
| `e2e` | The demo journeys in a real browser (Playwright) | A second copy of the app on ports 5180 and 8100, with its own database (`copilot_e2e`) filled with the demo story; the real AI and the mailbox |

## Running

```bash
docker compose --env-file .env up -d
```

```bash
cd backend && uv run pytest
```

```bash
cd backend && uv run pytest --live
```

The browser journeys start their own copy of the app and fill its database first, so the copy you use for development is never touched:

```bash
cd frontend && npm run e2e
```

## Adding a regression test

When a bug is fixed, add `backend/regression/test_<short_bug_name>.py` with a docstring saying what went wrong, and a test that fails without the fix.
