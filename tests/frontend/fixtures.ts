import type { Action, AskReply, DocumentDetail, DocumentSummary, Financing, FinancingQuote, Me, Recommendation } from "@/api/types";

/* Shapes copied from what the API returns (backend/app/api), so the screens are tested against the real contract. */

const levels = { "0": "Read", "1": "Suggest", "2": "Small change", "3": "Outside action", "4": "Two people" };

export const owner: Me = {
  user: { id: "u-owner", name: "Maya Patel", email: "owner@example.test", roles: ["owner"] },
  business: { id: "b1", name: "Demo Bakery", currency: "GBP", country: "GB", ai_paused: false },
  permissions: [
    "approve_high_risk", "approve_match", "approve_payment", "connect_tools", "edit_profile", "manage_users", "pause_ai",
    "prepare_payment", "reconcile", "record_bill", "review_documents", "send_reminder", "set_limits", "share_lender_pack",
    "submit_receipt", "use_assistant", "use_financing", "view_activity", "view_all", "view_own_submissions",
  ],
  approval_limit_minor: null,
  levels,
  unread_notifications: 0,
};

export const bookkeeper: Me = {
  ...owner,
  user: { id: "u-books", name: "Sam Taylor", email: "books@example.test", roles: ["bookkeeper"] },
  permissions: [
    "approve_match", "prepare_payment", "reconcile", "record_bill", "review_documents", "send_reminder", "submit_receipt",
    "use_assistant", "view_activity", "view_all", "view_own_submissions",
  ],
};

export const employee: Me = {
  ...owner,
  user: { id: "u-emp", name: "Alex Kim", email: "alex@example.test", roles: ["employee"] },
  permissions: ["submit_receipt", "view_own_submissions"],
};

const now = new Date().toISOString();

export function action(over: Partial<Action> = {}): Action {
  return {
    id: "a1",
    type: "approve_document",
    type_label: "Approve an extracted document",
    level: 2,
    level_label: "Small change",
    status: "pending",
    summary: "Record bill: £658.56 from Acme Supplies",
    effects: ["Add a bill to the ledger"],
    reasons: [],
    amount_minor: 65856,
    requested_by: "suggested by AI",
    approvals: [],
    required_approvals: 1,
    approvers: "One person (or automatic when small and confident)",
    can_approve: true,
    why_not: null,
    can_undo: false,
    document_id: null,
    result: null,
    created_at: now,
    decided_at: null,
    ...over,
  };
}

export function docSummary(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: "d1",
    filename: "acme-AS-1005.pdf",
    source: "email",
    status: "review",
    stage: "second_opinion",
    stage_label: "Second opinion",
    doc_type: "bill",
    counterparty: "Acme Supplies",
    total_minor: 65856,
    currency: "GBP",
    due_date: "2026-11-01",
    warnings: [],
    created_at: now,
    ...over,
  };
}

export function docDetail(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    ...docSummary(),
    fields: {
      doc_type: "bill", counterparty_name: "Acme Supplies", issue_date: "2026-10-02", due_date: "2026-11-01", currency: "GBP",
      reference: "AS-1005", subtotal: "548.80", tax: "109.76", total: "658.56", category_hint: "stock", line_items: [],
    },
    timeline: [
      { stage: "received", label: "Received", at: now, ok: true },
      { stage: "safety_check", label: "Safety check", at: now, ok: true, note: "pdf, 20480 bytes" },
      { stage: "archived", label: "Locked archive", at: now, ok: true },
      { stage: "reading", label: "Reading the text", at: now, ok: true, note: "1 page(s), text layer" },
      { stage: "hiding_details", label: "Hiding personal details", at: now, ok: true },
      { stage: "privacy_check", label: "Final privacy check", at: now, ok: true },
      { stage: "ai_form", label: "AI fills in the form", at: now, ok: true },
      { stage: "checks", label: "Do the numbers add up?", at: now, ok: true },
      { stage: "second_opinion", label: "Second opinion", at: now, ok: false, note: "Two independent readings disagree on: due date." },
    ],
    review_reasons: ["Two independent readings disagree on: due date."],
    warnings: [],
    pages: 1,
    mime: "application/pdf",
    sha256: "ab".repeat(32),
    sender_domain: "acme-supplies.example",
    sender_checks: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ai_saw: "Invoice AS-1005 from Acme Supplies. Pay to [BANK_ACCOUNT_1] sort code [SORT_CODE_1]. Total £658.56",
    highlights: [{ field: "total", page: 0, box: [0.7, 0.8, 0.85, 0.83] }],
    attempts: [
      { attempt: 1, role: "primary", model: "model-a", passed: true, problems: [], provider: "p1" },
      { attempt: 2, role: "second_opinion", model: "model-b", passed: false, problems: ["Due date differs."], provider: "p2" },
    ],
    actions: [],
    record_id: null,
    ...over,
  };
}

// Stage 7: recommendations, financing and Ask (backend/app/api/advice.py and assistant.py)

export const financeManager: Me = {
  ...owner,
  user: { id: "u-fm", name: "Priya Shah", email: "finance@example.test", roles: ["finance_manager"] },
  permissions: [
    "approve_match", "approve_payment", "connect_tools", "prepare_payment", "reconcile", "record_bill", "review_documents",
    "send_reminder", "submit_receipt", "use_assistant", "use_financing", "view_activity", "view_all", "view_own_submissions",
  ],
};

export function recommendation(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "r1",
    type: "price_rise",
    title: "Acme Supplies is charging 18% more",
    summary: {
      text: "Acme Supplies' flour went from £45.00 to £53.10 a sack (+18%).",
      redacted_input: "supplier: [SUPPLIER_1]\nusual price per unit: £45.00\nlatest price per unit: £53.10",
      ai_written: true,
    },
    severity: "attention",
    at_stake_minor: 97200,
    counterparty: "Acme Supplies",
    counterparty_id: "c1",
    created_at: now,
    updated_at: now,
    status: "new",
    why: "We compare each supplier's latest bills, and the prices on their lines, with the median of the 6 months before.",
    evidence: [
      { label: "Flour 25kg", before: "£45.00", after: "£53.10" },
      { label: "Latest bill", before: "", after: "£658.56", record_id: "rec1" },
    ],
    next_step: { label: "Draft an email to Acme Supplies about the increase", kind: "email_supplier", href: null, can_draft: true, action: null, related_action_ids: [] },
    can_mute: true,
    ...over,
  };
}

export const bankDetailsRec = recommendation({
  id: "r2",
  type: "bank_details_changed",
  title: "Northern Packaging's bank details changed",
  summary: { text: "A bill from Northern Packaging gives a different bank account from the one on record.", redacted_input: "", ai_written: false },
  severity: "urgent",
  at_stake_minor: 50400,
  counterparty: "Northern Packaging",
  evidence: [{ label: "Bank account", before: "•••• 4421", after: "•••• 9087" }],
  next_step: { label: "Ask Northern Packaging to confirm, using the email on record", kind: "email_supplier", href: null, can_draft: true, action: null, related_action_ids: ["a4"] },
  can_mute: false,
});

export function quote(over: Partial<FinancingQuote> = {}): FinancingQuote & { covers_need: boolean } {
  return {
    amount_minor: 262000,
    months: 1,
    total_cost_minor: 0,
    cost_range_minor: [0, 0],
    monthly_repayment_minor: 0,
    fee_minor: 0,
    rate_pct: [0, 0],
    factor: null,
    yearly_cost_pct: null,
    closes_gap: true,
    lowest_minor: 812000,
    lowest_on: "2026-12-02",
    first_below_on: null,
    forecast_effect: "With this, cash stays above your safety level for the next 90 days.",
    covers_need: true,
    ...over,
  };
}

export function financing(over: Partial<Financing> = {}): Financing {
  return {
    gap: {
      amount_minor: 262000, starts_on: "2026-11-28", lowest_on: "2026-12-02", ends_on: "2026-12-10", days: 12, months: 1,
      safety_level_minor: 1000000, lowest_minor: 750500, recovers: true,
    },
    need: { amount_minor: 262000, months: 1, source: "forecast" },
    options: [
      {
        id: "supplier-terms", type: "supplier_terms", provider: "Your suppliers", product: "Ask suppliers for longer payment terms", free: true,
        min_minor: 10000, max_minor: 5000000, min_months: 1, max_months: 2, about: "Free, but up to each supplier. Ask before the bill is due.",
        limit_minor: 450000, eligible: true, reasons: [], eligibility_note: null, quote: quote(),
      },
      {
        id: "overdraft", type: "credit_line", provider: "Northgate Bank (sample)", product: "Business overdraft", free: false,
        min_minor: 100000, max_minor: 2500000, min_months: 1, max_months: 12, about: "Pay interest only on what you use.",
        limit_minor: 2500000, eligible: true, reasons: [], eligibility_note: null,
        quote: quote({ total_cost_minor: 2584, cost_range_minor: [1938, 3230], monthly_repayment_minor: 2584, rate_pct: [9, 15], yearly_cost_pct: 12 }),
      },
      {
        id: "bank-loan", type: "term_loan", provider: "Northgate Bank (sample)", product: "Small business loan", free: false,
        min_minor: 500000, max_minor: 25000000, min_months: 12, max_months: 60, about: "Fixed monthly repayments.",
        limit_minor: 25000000, eligible: false, reasons: ["Available after 18 more months of trading."], eligibility_note: "Available after 18 more months of trading.",
      },
    ],
    readiness: [
      { id: "trading", label: "Months trading", value: "6 months", ok: false, tip: "Many lenders want 2 years of trading; some accept 6 to 12 months." },
      { id: "overdue", label: "Unpaid invoices over 30 days overdue", value: "12%", ok: true, tip: null },
    ],
    profile: {
      values: {},
      fields: [
        { field: "months_trading", label: "Months trading", auto: 6, value: 6, corrected: false, corrected_by: null, corrected_at: null },
        { field: "monthly_sales_minor", label: "Average monthly sales (6 months, before VAT)", auto: 1850000, value: 2000000, corrected: true, corrected_by: "u-owner", corrected_at: now },
        { field: "card_share", label: "Share of sales paid by card", auto: 0.42, value: 0.42, corrected: false, corrected_by: null, corrected_at: null },
      ],
      owner_fields: { industry: "Bakery", business_type: null, assets: null, credit_band: "good", purpose: null, country: "GB" },
      choices: { business_type: ["sole_trader", "partnership", "limited_company"], credit_band: ["poor", "fair", "good", "excellent"], purpose: ["cash_flow", "vehicle", "equipment"] },
    },
    safety_level_minor: 1000000,
    disclaimer: "These options are information to help you compare, not financial advice.",
    summary: {
      text: "Cash is expected to fall £2,495.00 below your safety level from 28 November. Asking suppliers for longer terms would cover it for free.",
      redacted_input: "shortfall: cash goes below the safety level of £10,000.00",
      ai_written: true,
    },
    lender_pack: { available: true, can_share: true, approver: "A business owner approves sharing it." },
    ...over,
  };
}

export function askReply(over: Partial<AskReply> = {}): AskReply {
  return {
    id: "m2",
    thread_id: "t1",
    answer: {
      text: "Bright Cafe owes you the most: £1,240.00, of which £860.00 is overdue.",
      redacted_input: "Question: Who owes me the most?\n\nTool results:\n[CUSTOMER_1] owes £1,240.00",
      ai_written: true,
    },
    blocks: [{ type: "table", title: "Who owes you", columns: ["Customer", "Owed", "Overdue"], rows: [["Bright Cafe", 124000, 86000], ["Hill Farm Shop", 42000, 0]], money_columns: [1, 2] }],
    sources: [
      { id: "inv1", kind: "invoice", label: "Invoice INV-1042" },
      { id: "cash-flow", kind: "page", label: "Cash flow", href: "/cash-flow" },
    ],
    follow_ups: ["When did Bright Cafe last pay?", "What does my cash look like next month?"],
    suggestion: { type: "send_payment_reminder", counterparty_id: "c9", label: "Draft a payment reminder to Bright Cafe" },
    ...over,
  };
}
