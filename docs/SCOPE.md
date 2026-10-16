# Project Scope

## Who it is for

Owners of small businesses who don't have a finance team. They get paid through a payment platform, receive bills by email, keep money in a bank account, and may or may not use accounting software.

## The problems we solve

| Problem | What our app does |
|---|---|
| Money information is scattered across many tools | Pulls everything into one record of money in and out |
| Bills and receipts are typed in by hand | Reads documents automatically, privately |
| Checking payments against invoices takes hours | Matches them automatically and asks a person only when unsure |
| Nobody knows what cash will look like next month | Forecasts cash 7, 30, 60 and 90 days ahead |
| Bills arrive as a surprise | Warns before a bill causes a shortfall |
| "Why is my cash down?" | Explains the main reasons in plain words |
| Owners can't see how the business is really doing | A business health page: profit, spending, who owes money, runway |
| Supplier price rises and changed details go unnoticed | Recommendations that flag them and say what to do |
| Some customers always pay late | Spots slow payers and suggests deposits, shorter terms or earlier reminders |
| Cash runs short | Compares financing options by real cost and their effect on the forecast |
| Finance questions with nobody to ask | A chat assistant answers them using the business's own numbers |

## What we deliver

### 1. Bringing the data together
- **Connections:** email inbox (required), payment platform, bank account and accounting software (optional).
- **Manual input:** upload a PDF, image or spreadsheet, or take a photo of a receipt in the app.
- **Automatic reading:** bills, invoices, receipts and payment notices are read on arrival, with personal details hidden before the AI sees anything.
- **Automatic matching:** payments are matched to invoices, payouts to bank deposits, and bills to bank payments.
- **Review list:** a short list of items for a person to check, showing the original document next to what was extracted.

### 2. Managing cash flow
- **Live cash position** across all connected accounts.
- **Forecasts:** 7, 30, 60 and 90 days ahead, updated whenever new information arrives.
- **Early warnings:** upcoming bills that would push cash below a safe level.

### 3. Understanding the business
- **Business health page:**
  - profit and loss by month: sales, costs, profit and margin;
  - where the money goes: spending by category and top suppliers;
  - who owes you: unpaid invoices by how overdue they are, and how long customers take to pay;
  - cash runway: how many months cash lasts at the current rate of spending;
  - health checks in plain words, such as "costs have grown faster than sales for 3 months".
- **Explanations:** "Why did cash change?", with the top reasons ranked, such as higher supplier costs, lower sales or late customer payments.
- **What-if:** "Can I afford a new van?" adds the cost to the forecast and shows the new lowest cash point.

### 4. Recommendations
An AI agent reviews the business's own records whenever new data arrives and once a day, and raises recommendations such as:
- **Supplier details changed:** "Acme Supplies' address and phone number changed on 12 October. Before: 4 Mill Lane. Now: 22 High Street." A bank-detail change is also treated as a fraud warning.
- **Supplier price rise:** "Acme charged £540 this month, 18% more than its usual £458."
- **Slow-paying customer:** "Bright Cafe pays on average 10 days after the due date. Consider asking for a deposit or payment upfront."
- **Spending creep:** a cost category or subscription growing month after month.
- **Reliance on one customer:** one customer bringing in a large share of sales.

Each recommendation shows the numbers behind it and a suggested next step, such as drafting an email to the supplier. Nothing is sent or changed without approval.

### 5. Financing options
- **Business profile:** filled in automatically from the business's data (months trading, sales, card sales, unpaid invoices, existing repayments), plus a few details the owner adds (country, industry, what the money is for). The owner can correct any value; we keep the original next to the correction.
- **Financing catalog:** a list of financing products, each with its amount and term range, cost and eligibility rules. In our demo the providers and rates are sample data.
- **Automatic matching:** when a shortfall is forecast, or a what-if shows a gap, suitable options are matched to its size and length.
- **Financing page:** the owner can also browse the catalog themselves, filtered to what they qualify for, and move amount and term sliders to see the cost and effect on the forecast.
- **Side-by-side comparison:** each option's total cost in money, not just a rate, and its monthly repayment.
- **Effect on the forecast:** each option is run through the forecast, for example "with this loan, cash stays above your safety level until March".
- **Readiness:** what a lender would look at and what would improve the business's chances.
- **Lender pack:** a PDF of the profile, profit and loss and unpaid invoices that the owner can share with a lender. Sharing it needs approval; nothing is ever applied for automatically.

### 6. Chat assistant
- **Questions about the business in plain English,** for example:
  - "How is the business doing this quarter?"
  - "What is my cash flow looking like next month?"
  - "Which supplier costs me the most, and has that changed?"
  - "Who owes me the most, and who pays late?"
  - "Can I afford a new van next month?"
- **Answers come from the business's own numbers,** fact-checked before they are shown.
- **Suggested actions,** such as reminding a customer to pay. Anything important waits for a person's approval.

### 7. A clean, interactive app
- **Calm screens:** one headline number, at most one main chart and a few cards per page, with detail one click away.
- **Interaction that builds trust:** click any number to see its source document, see exactly what the AI saw, watch documents being processed live, and drag bills or planned costs on the forecast.
- **Fast everyday use:** a Today briefing, an inbox for approvals with keyboard shortcuts, voice questions, phone-to-computer receipt handoff and a privacy mode that hides amounts.

See [Product design](DESIGN.md) for details.

### 8. Trust and control
- **Approval levels:** the AI can read and suggest freely; money and outside actions need people (see [Security](SECURITY.md)).
- **Pause AI switch:** the owner can stop all automatic AI actions at once.
- **Permanent activity log** of every step.
- **Every number traceable** to its original document.

## In our demo

Every service runs in a safe test mode with fake money and data.

| Type | Service used |
|---|---|
| Email inbox | Mailpit (test inbox) |
| Payment platform | Stripe test mode |
| Bank account | Plaid test bank (statement upload also supported) |
| Accounting software | QuickBooks Online test company |
| AI model | Any model on OpenRouter, limited to providers that don't keep or train on our data |
