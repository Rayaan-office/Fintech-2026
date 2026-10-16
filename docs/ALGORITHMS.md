# Core Algorithms

This document explains how we turn raw documents and transactions into forecasts, warnings, analysis and recommendations. Wherever possible we use simple, predictable rules. AI is used only where reading or explaining language is needed, and every AI answer is checked by our own code.

## 1. Hiding personal details

Before any text reaches the AI, we find and replace sensitive details.

| Detail | How we find it |
|---|---|
| Card numbers | Number pattern plus the card checksum (Luhn) |
| Bank account numbers (IBAN, sort code, routing number) | Number pattern plus the bank checksum where one exists |
| Tax and company IDs | Country-specific patterns |
| Emails, phone numbers, web links | Patterns |
| People's names and addresses | Microsoft Presidio's language model for names and places |

Each value becomes a placeholder such as `[BANK_ACCOUNT_1]`. The real value goes into a separate encrypted store, so we can put it back after the AI has finished. A final scan checks the outgoing text again, and if anything is left, nothing is sent.

## 2. Reading a document

1. **Read the text** from the PDF, or with OCR for photos and scans, noting where each word sits on the page.
2. **Hide personal details** (section 1).
3. **AI fills in a fixed form:** document type, supplier or customer, dates, currency, line items, tax, total, and invoice or reference number.
4. **Our code checks the form:**
   - every required field is filled in;
   - line items add up to the subtotal, and subtotal plus tax equals the total;
   - dates make sense (for example, the due date is not before the issue date);
   - every amount, date and reference number actually appears in the document text.
5. **If a check fails:** the AI tries once more and is told exactly what was wrong. If it fails again, a second AI model reads the document independently. If the two agree on the key fields (total, currency, due date, supplier), we accept the result. If not, a person decides.

## 3. Matching payments

We link every invoice, bill and payment to its partner, such as an invoice to the customer payment that settled it, or a payout to the bank deposit it became.

**Step 1: exact rules.** These come first and settle most cases:
- the payment carries the invoice number;
- the payout ID from the payment platform matches the bank deposit;
- the amount, the other party and the date all match exactly.

**Step 2: scoring.** For anything left over, each possible pair earns points:

| Signal | Points |
|---|---|
| Same amount (allowing small fees) | 40 |
| Reference or invoice number found | 30 |
| Dates close together | 20 |
| Similar name of the other party | 10 |

- **85 points or more:** a confident match. It is accepted automatically if the approval rules allow it.
- **60 to 84 points:** a suggestion that a person confirms.
- **Below 60:** left unmatched.

One payment can also settle several invoices, or arrive in parts; we test those combinations too.

**Never suggested:** a payment that names a different invoice or bill of ours, or clearly comes from a different customer or supplier; and two items from the same accounting or payment software, which already records what each payment settled. A pair a person turned down is not suggested again, and a suggestion that no longer fits (the invoice was paid another way, the payment was cancelled) is withdrawn.

**Same money, seen twice:** a bank payment for an invoice or bill the accounting software already shows as paid is linked to it without changing either. We find it by the invoice number, or for direct debits and card payments by the same party, amount and date.

## 4. Cash forecast

![How the cash forecast is built](diagrams/cash-forecast.png)

We build the forecast day by day for the next 90 days from these ingredients:

1. **Cash today** across all connected accounts.
2. **Money expected in:** each unpaid invoice is placed on the day the customer is likely to pay, based on how late that customer has paid before.
3. **Money going out:** bills on their due dates, plus scheduled payments.
4. **Repeating items:** rent, salaries and subscriptions, spotted because the same party is paid a similar amount at a regular interval. Regular customers and suppliers are spotted from how often they are invoiced or billed, which is steadier than when they pay; their next invoices and bills are placed after their usual payment delay.
5. **VAT:** when the bank doesn't yet show a regular VAT payment, we estimate the next one from the VAT on that quarter's invoices, bills and card sales.
6. **Everyday pattern:** the typical net in or out for each day of the week, covering everything not listed above.
7. **Planned costs** the owner adds, which never change real records.

Bills that are already overdue are assumed to be paid now. Invoices more than 60 days overdue are only counted in the best case. Money already sitting in the payment platform arrives with the next payout, so it isn't counted twice. Accounts and items in another currency are left out and listed, because we hold no exchange rates.

We show an **expected** line, plus a **best** and **worst** case built from how much customer payment dates and everyday activity have varied in the past. The forecast is recalculated whenever a new payment, bill or bank record arrives.

## 5. Early warnings

1. Walk through the forecast day by day.
2. Find the first day the expected balance drops below the owner's **safety level** (by default, two weeks of usual spending).
3. Identify the bills and payments that cause the drop.
4. Raise a warning that names them and says how many days are left, for example "Rent on 3 November will take you below your safety level".

Warnings are graded **watch** (worst case only), **warning** (expected case) and **urgent** (within 7 days).

## 6. Business health

All figures come from our single record of money in and out. Each item is given a category (such as rent, stock or software) from the accounting software, or from the supplier's past bills if there is none.

| Measure | How we calculate it |
|---|---|
| Profit and loss | Sales minus costs for each month; margin is profit divided by sales |
| Where the money goes | Spending grouped by category, plus the ten largest suppliers |
| Who owes you | Unpaid invoices grouped as not yet due, 1–30, 31–60, 61–90 and over 90 days overdue |
| Days to get paid | Average days from invoice date to payment over the last 90 days, weighted by amount |
| Cash runway | Cash today divided by the average monthly net outflow over the last 3 months (shown only when the business is spending more than it earns) |

**Health checks** are simple rules that raise a plain-words note:
- costs have grown faster than sales for 3 months in a row;
- margin has fallen by more than 5 points compared with the previous quarter;
- more than 20% of unpaid invoices are over 30 days overdue;
- runway is under 3 months.

## 7. Explaining why cash changed

1. Compare two periods, for example this month against last month.
2. Split the change into groups: customer payments (noting how much that fell due is still unpaid, which shows late payment), card sales, supplier costs, salaries, rent, tax, financing and one-off items. The groups add up exactly to the change.
3. Rank the groups by how much each moved cash, and find the largest single items within each.
4. The AI writes a short explanation **from these numbers only**.
5. Our code then checks that every figure in the explanation matches the calculation. If it doesn't after one rewrite, we show our own plain sentence instead.

## 8. What-if: "Can I afford this?"

1. The owner, or the chat assistant, describes a planned cost: amount, date, and whether it is one-off or repeating.
2. We add it to a copy of the forecast. Real records are not changed.
3. We report the new lowest cash point, its date, and whether it falls below the safety level, in the expected and worst case.
4. If it does, we show how much is missing and link to the financing options (section 10).

## 9. Recommendations

![How recommendations are made](diagrams/insights-graph.png)

An AI agent reviews the business's own records whenever new data arrives and once a day.

1. **Our code finds the facts.** Fixed rules (below) look for patterns and record the numbers and documents behind each one.
2. **Rank and remove repeats.** Findings are ranked by money at stake and urgency. A finding already shown is not shown again unless it gets worse (more urgent, or 20% more at stake). One that no longer holds, such as a fraudulent bill that was turned down, is marked resolved.
3. **The AI writes the recommendation** from the finding only. Names appear as placeholders such as `[SUPPLIER_1]`, and our code puts the real names back afterwards.
4. **Fact check.** Every figure in the text must match the finding: money must be money from the finding and a percentage a percentage from it (rounding to the pound is allowed), and every placeholder must be one we sent. The AI gets one rewrite, told exactly what was wrong; after that, or while AI is paused, we show our own plain wording.
5. **Show it with a next step.** Clicking the next step drafts an email (also worded by the AI and fact-checked), which waits in the inbox for approval. It always goes to the address on record; when details have changed, to the address on record before the change.

| Recommendation | When it is raised | Suggested next step |
|---|---|---|
| Supplier details changed | The address, email, phone or bank details on a new bill (approved or still waiting) differ from the supplier's record. We keep every past version, so we can show before and after. The same address read slightly differently is not a change. All the changes on one bill are one finding; bills sharing the same new bank details are one finding. | Confirm with the supplier using the contact details already on record. Bank-detail changes also raise a fraud warning (section 11). |
| Supplier price rise | The supplier's latest two bills (the latest, for a monthly supplier) are 10% or more above its usual level (the median of the 3 months before), or a price per unit on a bill is 10% or more above that line's usual price. Where past bills show only line totals, the usual unit price is the largest price that most past totals are whole multiples of (8 bags at £45.00 is £360.00). A charge that rises step by step every month is spending creep instead. | Draft an email asking about the increase, or compare with other suppliers |
| Slow-paying customer | Across at least 3 invoices, a customer pays 7 or more days after the due date on average, or their invoices of the last 60 days are paid 7 or more days late and 3 or more days later than before | Ask for a deposit or payment upfront, shorten payment terms, offer an early-payment discount, or send a reminder before the due date (a reminder is drafted when invoices are overdue) |
| Spending creep | A spending category rose in each of the last 3 full months, by 10% or more and at least £10 a month in all, or a new supplier has billed about once a month for the last 100 days | Review the cost |
| Reliance on one customer | One customer brought in more than 30% of sales over the last 90 days | For information |

The owner can dismiss a recommendation; dismissing it mutes that kind of recommendation for that supplier or customer. Changed bank details are never muted: a different change is always shown.

## 10. Financing options

### Business profile

| Filled in automatically | Added by the owner |
|---|---|
| Months trading (from the first transaction) | Country and industry |
| Average monthly sales over 6 months, and their trend | Business type (for example sole trader or company) |
| Share of sales paid by card | Assets owned, such as property or vehicles |
| Unpaid invoices and days to get paid | Self-declared credit band |
| Existing loan repayments (repeating payments to lenders) | What the money is for |

The owner can correct any automatic value. We keep the original next to the correction and note who changed it.

### Financing catalog

A table of 11 products loaded from a data file. Each product has a type, provider, amount range, term range, rate range, fees and eligibility rules, such as minimum months trading, minimum monthly sales, needs card sales, needs unpaid invoices, and countries served. In our demo the providers and rates are sample data. In production the catalog would be kept up to date by our team, including government-backed schemes, or supplied by a lender marketplace partner.

### Matching steps

1. **Work out the need.**
   - From the forecast: the amount is the safety level minus the lowest expected balance, plus 5% for the cost of borrowing, rounded up to £100. The length runs from the first day below the safety level until cash recovers, so repayments start after that.
   - From a what-if: the amount missing at the lowest point.
   - From the owner: an amount and purpose typed in, such as "£20,000 for a van".
2. **Check eligibility.** Each product's rules are checked against the profile. Products the business doesn't qualify for are removed. Near misses are shown with the reason, for example "available after 3 more months of trading".
3. **Work out the cost** for the amount and length needed, using the middle of the rate range and showing the range too:

   | Product | How cost is worked out |
   |---|---|
   | Ask a supplier for longer terms | Free; up to the bills currently unpaid |
   | Discount early payment from customers | The discount given (2% in the sample catalog); up to the unpaid invoices |
   | Loan (short-term, bank, start-up, vehicle and equipment) | Standard monthly repayment formula, plus fees, which come off the money received |
   | Line of credit or overdraft | Interest only on the amount and days used, plus fees; the amount is repaid at the end |
   | Invoice financing | Monthly fee times the invoices used, until customers usually pay; up to 85% of unpaid invoices paid upfront |
   | Merchant cash advance | Fixed multiple of the amount, repaid as 12% of card sales; we estimate how long that takes and show the yearly cost, which is usually high |

4. **Check the effect on the forecast.** The money in and the repayments are added to a copy of the forecast, and we report whether cash stays above the safety level.
5. **Rank.** Options the business qualifies for first: free options, then options that keep cash above the safety level, each by total cost.
6. **Readiness checklist.** What a lender usually looks at: months of trading, sales trend, share of overdue invoices, existing repayments compared with monthly cash coming in, and how up to date the books are. Each item says what would improve it. It is not a credit score.
7. **Summary.** The AI writes a short summary from these numbers, which is fact-checked.

The same steps run in two ways: **automatically** when the forecast shows a shortfall, and **on the Financing page**, where the owner browses the catalog and moves amount and term sliders to recalculate cost and forecast effect.

### Lender pack

On request we generate a PDF with the business profile, profit and loss for the last 12 months, unpaid invoices and the cash forecast. Every figure comes from our records. Sharing it with a lender is an outside action and needs approval. We never apply for financing on the owner's behalf.

We present financing options as information, not personal financial advice.

## 11. Fraud warnings

| Warning | Trigger |
|---|---|
| Changed bank details | A supplier's bank details differ from the ones on record |
| Duplicate invoice | Same file fingerprint, or same supplier, invoice number and amount |
| Look-alike sender | The email domain is one letter away from a known supplier's |
| Failed sender checks | The email fails the standard sender checks (SPF, DKIM, DMARC) |
| Unusual amount | Far above that supplier's usual range |
| Pressure tactics | A new supplier whose message uses urgent payment language |

Any warning blocks automatic processing and sends the item to a person.

## 12. Answering questions about the business

The chat assistant answers using read-only tools that run the calculations above. It never reads raw documents.

| Tool | Answers questions such as |
|---|---|
| Cash position and forecast | "What does my cash flow look like next month?" |
| Profit and loss, spending | "How is the business doing this quarter?", "What do I spend most on?" |
| Who owes you, customer payment habits | "Who owes me the most, and who pays late?" |
| Supplier history | "Has Acme put its prices up?" |
| Why cash changed | "Why is my cash lower than last month?" |
| What-if | "Can I afford a new van next month?" |
| Financing options | "How could I cover a shortfall in December?" |
| Recommendations | "Is there anything I should look at?" |

How it stays safe and correct:
- **Names hidden.** Supplier and customer names in the question (including a short form such as "Acme") become placeholders, other personal details are hidden as in section 1, and tool results use the same placeholders.
- **Fixed, read-only tools.** The AI can only pick tools from this list, at most three per question. They run in a database transaction that refuses any change and sees one business. Tools the person's role doesn't allow (financing, for bookkeepers) are left out and the answer says so. Questions not about the business are declined.
- **Fact check.** Every figure in the answer must come from the tool results or the question, as in section 9. After one rewrite we show the figures in plain form instead.
- **Charts and tables from our code.** The chart or table under an answer and its sources come from the tool results, never from the AI.
- **Actions only on a click.** The AI may suggest a payment reminder or a supplier email. It becomes a draft only when the person clicks it, and then waits for approval.
- **Private history.** Each conversation belongs to one person; the AI sees only that conversation's earlier turns, as placeholders.
