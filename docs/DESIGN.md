# Product Design

Small-business owners are busy and are not accountants. Our app should feel calm: one clear answer per screen, the next step always visible, and the detail one click away rather than dumped on the page. This document explains how we designed the interface and what makes our interaction different.

## What we studied

Before designing, we studied how leading finance products present money, approvals and AI.

| Product | How we studied it | What we took from it |
|---|---|---|
| Mercury (banking and accounting) | Its public live demo, and the structure of its web app's code | A calm home page with one balance chart and a few small cards; a **Tasks** list written as plain sentences ("Approve £1,042.95 payment to Jason Green, requested by Alice"); an AI assistant that **confirms before acting**, asks follow-up questions as clickable options, and links each answer to the records behind it; insights written as two or three short sentences beside one chart; a **privacy mode** that hides all amounts; a graph-or-table switch on every chart; detail panels that slide in from the right while the list stays visible |
| Stripe (payments) | Its published dashboard design guidelines | A **side panel** for looking at something in context, and a **focused panel** for tasks that must be finished start to finish; set patterns for empty, loading and in-progress states; one main action per screen; limited colours so contrast stays readable; press `?` to see keyboard shortcuts |
| QuickBooks and Xero (accounting) | Their product pages and well-known screens | Bank transactions waiting "for review" with a suggested match and one-click **Match**; the statement line on one side and the suggested match on the other; short-term cash-flow projections where planned bills can be switched on and off to test "what if" |

## Our design rules

We follow Jakob Nielsen's ten usability heuristics, the most widely used checklist for interface design.

| Heuristic | What it means in our app |
|---|---|
| 1. Show what is happening | A document's journey (reading, hiding details, AI, checks, matching) is shown live. Each connection shows "Synced 2 minutes ago". Loading shows the shape of the page, never a blank screen. |
| 2. Speak the user's language | "Money in", "Bills due", "Who owes you" instead of "AR/AP". Amounts in pounds with pence shown smaller. Hover any money term for a one-line explanation. |
| 3. Let people undo and exit | Every small automatic change shows an **Undo** message. Any AI action can be cancelled at its confirmation card. Recommendations can be dismissed. `Esc` closes any panel. |
| 4. Be consistent | One set of components, one set of status colours, and the same approval badge in chat, the inbox and every detail panel. |
| 5. Prevent errors | Before anything happens, a confirmation card says exactly what will change. Risky actions need two people. A disabled button always says why. |
| 6. Show, don't make people remember | Suggested questions in chat, recently viewed items, search from anywhere (`Ctrl/⌘ K`), and the original document always beside what we extracted. |
| 7. Make experts faster | Keyboard shortcuts for review (`J`/`K` to move, `A` approve, `E` edit), approving several items at once, and saved filters. |
| 8. Keep it minimal | Each page has one headline number, at most one main chart, and no more than three summary cards. Everything else sits behind "View details". |
| 9. Explain problems and the fix | Errors say what happened and what to do: "The bank connection has expired. Reconnect." |
| 10. Help in context | A "Why am I seeing this?" link on every warning and recommendation, a short first-run tour, and help icons next to anything unfamiliar. |

## Layout

- **Left menu** with an icon and a label for each item: Home, Inbox, Ask, Cash flow, Business health, Financing, Documents, Activity. Connections and Settings sit at the bottom. The Inbox shows a count.
- **Top bar:** search everything, privacy mode (hide amounts), notifications and the user menu.
- **Side panel:** opening any record, such as a bill, customer or recommendation, slides a panel in from the right. The list stays visible, so people never lose their place.
- **Focused panel:** tasks that must be finished, such as reviewing a document or approving a payment, open in a wider panel that dims the rest of the page.

## The main screens

| Screen | What the user sees |
|---|---|
| Home | A greeting and a **Today** briefing of up to three things to act on, each with a one-tap button. Cash today with a small 90-day forecast. Three cards: bills due, who owes you, and recommendations. Quick buttons: Upload, Ask, Plan a cost. |
| Inbox | Everything waiting for a person, in tabs: To review, Needs approval, Done. Each item is one plain sentence with its approval badge, for example "Approve £1,240 payment to Acme Supplies, prepared by Sam". |
| Cash flow | The headline is the **lowest point** in the next 90 days and its date. One forecast chart with a best-to-worst band and each bill as a marker. Warnings listed underneath. |
| Business health | Four headline numbers: profit, margin, days to get paid and runway. One chart that switches between profit and loss, spending, and who owes you. Health checks as short sentences beside it. |
| Recommendations | One card per recommendation, each with a type icon, the money at stake and a single next step. "Before and after" evidence opens in the side panel. |
| Financing | The amount and length of the gap at the top. Option cards with free options first. Amount and term sliders, the effect on the forecast, the readiness checklist and the lender pack. |
| Documents | The review view puts the original on the left with each found value highlighted, and the extracted fields on the right with a confidence dot. |
| Ask | The chat assistant (see below). |
| Activity | A timeline of every step, with filters and a "Log intact" badge confirming the tamper-evident chain checks out. |
| Connections | One card per source with a status dot, last sync time and a reconnect button. |

## Visual style

- **Colour:** soft neutral greys with one accent colour. Status colours are used only for meaning: green for done or healthy, amber for needs attention, red for urgent. Money in is green; money out stays neutral, so the page never looks alarming by default.
- **Type:** Inter, with tabular figures so amounts line up. Pence are shown slightly smaller.
- **Icons:** Lucide, one icon per menu item, recommendation type and source. Suppliers and customers show initials in a circle.
- **Charts:** area charts for cash over time and bar charts for comparing categories. No pie charts or decorative charts. Every chart has a table view.
- **Spacing:** generous white space on an 8-pixel grid, with cards that have a thin border, rounded corners and a very light shadow.

## Motion

Animation explains change; it is never decoration. Most movements last 150–300 milliseconds.

- Side panels slide in and out.
- New items, such as a just-matched payment or a new recommendation, glide into lists, and approved items slide out.
- Headline numbers count up or down when they change.
- The forecast line reshapes smoothly when a what-if is added or a bill is moved.
- The steps of a document's journey light up one by one as it is processed.
- A short tick animation confirms an approval.
- People who switch on "reduce motion" on their device get instant changes instead.

## How the AI and approvals appear

- **AI text is labelled** with a sparkle icon and "Checked against your records", plus a link to **What the AI saw**: the exact text that was sent, with placeholders instead of names and numbers.
- **Every AI action shows its approval level** as a badge with an icon: Read, Suggest, Small change, Outside action, or Two people.
- **Confirmation card:** before anything happens, the card says what will change, which records are affected, the level and who must approve, with Approve, Edit and Cancel buttons.
- **Two-person actions** show progress, for example "1 of 2 approvals", and the name of the first approver.
- **Small automatic changes** show an Undo message for a few seconds and always appear in the Activity log.

## What makes our interaction different

1. **Show your work.** Click any number in chat, on the health page or in a recommendation to open the original document with that value highlighted.
2. **What the AI saw.** A toggle on any AI result shows the exact text sent to the AI, with personal details replaced, and confirms the provider keeps nothing.
3. **Watch a document being processed.** New bills move through each step live, including a retry or second opinion when one happens.
4. **Plan on the timeline.** Drag a bill to a later date, or drop a planned cost such as "new van" onto the forecast, and the lowest point updates instantly. Financing options appear as cards that can be dropped onto a gap.
5. **Answers you can act on.** The assistant replies with small charts, tables that can be copied or downloaded, and buttons such as "Draft reminder". When the question is unclear, it asks a follow-up as clickable options. Approvals happen right in the chat.
6. **Phone handoff.** Scan a QR code on the computer, photograph a receipt with your phone, and watch it arrive on the computer seconds later.
7. **Today briefing.** Up to three things to act on each morning, with one-tap actions, which can also be read aloud.
8. **Fast review.** Keyboard shortcuts on a computer and swipe gestures on a phone, with each item explaining why it needs approval.
9. **Ask by voice.** Speak a question instead of typing, using the browser's built-in speech recognition.
10. **Privacy mode.** One click hides every amount, so the app is safe to open in a café or on a shared screen.
11. **Fraud drill.** In our demo, an invoice with changed bank details is caught, explained in plain words, and blocked until two different people approve.

## Accessibility

- Colour contrast meets WCAG AA, and colour is never the only signal; icons and words go with it.
- Everything works with a keyboard, with visible focus.
- Every chart has a table view.
- Screen-reader labels on icons and charts.
- Motion follows the device's reduce-motion setting.

## Technology

| Part | Technology |
|---|---|
| Components | shadcn/ui (built on Radix UI) with Tailwind CSS |
| Icons | Lucide |
| Charts | Recharts |
| Animation | Motion (formerly Framer Motion) |
| Search and shortcuts | cmdk (search box), react-hotkeys-hook |
| Notifications and Undo | Sonner |
| Long lists | TanStack Table and TanStack Virtual |
| Live updates | Server-sent events from our server |
| Voice and phone handoff | Web Speech API, QR code (qrcode.react) |
