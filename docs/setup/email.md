# Email inbox (Mailpit)

Bills reach Cocent by email. In our demo the inbox is **Mailpit**, a test mail server that runs on your computer in Docker. Nothing to sign up for, and no email leaves your computer.

## How it works

- `docker compose up -d` starts Mailpit. Its inbox is at http://localhost:8025.
- Mailpit tells Cocent the moment an email arrives. The server must be running on port 8000 to hear it. If it wasn't, "Sync" on the email card in Connections catches up.
- The demo business's bills inbox is `BILLS_INBOX_ADDRESS` in `.env` (`bills@demo-business.test`). Emails sent to any other address are ignored.
- Emails that Cocent sends after approval, such as payment reminders, also land in Mailpit, so you can read them there.

## Sender checks in the demo

Real email carries a signature that proves which domain sent it, and the receiving mail server adds its verdict. Our demo suppliers' domains don't exist, so:

- the demo-data script signs each email with a key for its domain, created on first use in `backend/.local/` (never committed);
- it adds the verdict our receiving server would give, under the name in `MAIL_AUTHSERV_ID`. Cocent ignores verdicts under any other name, so a sender can't forge one.

## Send the demo emails

From `backend/`, with the server running:

```bash
uv run python -m app.demo.emails
```

See [Demo data](demo-data.md) for what each email is and how to send just one.

## In production

The business forwards its bills to a dedicated inbox, and Cocent reads it over IMAP, the standard way to read any mailbox. Each email is still processed only once, tracked by its message ID.
