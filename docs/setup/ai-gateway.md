# AI gateway (OpenRouter)

Cocent reaches AI models through OpenRouter, one gateway in front of many models. We use it because every request can insist on providers that **keep nothing and never train on our data**. Cocent asks for this on every request, so you don't need to change any account setting. If no such provider is available, the request fails instead of going elsewhere.

You need this for both the quick look and the full setup.

## 1. Create an account and add credit

1. Sign up at [openrouter.ai](https://openrouter.ai).
2. Open **Credits** and add a small amount. Five US dollars is plenty for testing. Cocent also stops itself at a daily limit (`AI_DAILY_BUDGET_USD` in `.env`, 10 by default).

## 2. Create a key

1. Open **Keys**, then **Create key**.
2. Give it a name and a credit limit (for example 5).
3. Copy the key into `.env`:

```
OPENROUTER_API_KEY=<your key>
```

## 3. Choose two models

Cocent uses two different models. The first reads documents and writes the plain-English wording. The second gives an independent opinion when the first one's answer fails our checks.

On the [Models](https://openrouter.ai/models) page, choose two models from different companies that:

- support **structured outputs** (filter by it), because every answer must fill in a fixed form;
- have at least one provider marked **zero data retention**, shown on the model's Providers tab.

Copy each model's exact ID (shown under its name) into `.env`:

```
AI_MODEL_PRIMARY=<first model ID>
AI_MODEL_SECOND_OPINION=<second model ID>
```

## 4. Optional: a second safety net

Cocent hides personal details before any text leaves the server, so this step is optional. OpenRouter's **Guardrails** add a second check on top. We use one like this:

1. Open **Settings**, then **Guardrails**, then create one.
2. **Prompt injection:** on, for all messages, set to **Block**.
3. **Sensitive information:** **Block** card numbers, API keys, email addresses and other IDs, and add your own patterns for UK bank details (IBAN, sort code, account number) and tax numbers. **Redact** phone numbers, postcodes and IP addresses.
4. **Models:** allow only the two models you chose.
5. **Budget:** a daily limit.
6. Attach the guardrail to your key.

If the guardrail blocks a document, Cocent sends it to a person marked "possible hidden instructions or a sensitive detail", as described in [Security](../SECURITY.md).

## Check it works

Start the app, upload a bill on the Documents page, and open it. Under "What the AI saw" you can see the text that was sent, with names and bank details already replaced by placeholders.
