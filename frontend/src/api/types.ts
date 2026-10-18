/*
 * Shapes the app expects from the API. Money is always integer minor units (pence) with
 * a `_minor` suffix; dates are ISO 8601 strings.
 */

export type ApprovalLevel = 0 | 1 | 2 | 3 | 4;
export type Severity = "info" | "attention" | "urgent";

// Auth

export type Role = "owner" | "finance_manager" | "bookkeeper" | "employee";

export type Permission =
  | "view_all"
  | "view_own_submissions"
  | "submit_receipt"
  | "review_documents"
  | "approve_match"
  | "record_bill"
  | "reconcile"
  | "prepare_payment"
  | "send_reminder"
  | "approve_payment"
  | "approve_high_risk"
  | "connect_tools"
  | "use_financing"
  | "share_lender_pack"
  | "edit_profile"
  | "manage_users"
  | "set_limits"
  | "pause_ai"
  | "use_assistant"
  | "view_activity";

export type Me = {
  user: { id: string; name: string; email: string; roles: Role[] };
  business: { id: string; name: string; currency: string; country: string; ai_paused: boolean };
  permissions: Permission[];
  approval_limit_minor: number | null;
  levels: Record<string, string>;
  unread_notifications: number;
};

export type LoginResult = { totp_required: boolean; totp_setup_required: boolean };
export type TotpSetup = { otpauth_uri: string; secret: string };

// Shared pieces

export type RecordRef = { id: string; kind: string; label: string; href?: string };

export type Approval = { user_id?: string; name: string; at: string };

export type ActionStatus = "pending" | "executed" | "rejected" | "cancelled" | "failed" | "undone";

/** A change waiting for (or past) its approvals, exactly as the server describes it. */
export type Action = {
  id: string;
  type: string;
  type_label: string;
  level: ApprovalLevel;
  level_label: string;
  status: ActionStatus;
  summary: string;
  effects: string[];
  reasons: string[];
  amount_minor: number | null;
  /** "suggested by AI" or "prepared by <name>". */
  requested_by: string;
  approvals: { name: string; decision: string; at: string }[];
  required_approvals: number;
  /** Who must approve, in plain words. */
  approvers: string;
  can_approve: boolean;
  /** Why this person can't approve, when they can't. */
  why_not: string | null;
  can_undo: boolean;
  document_id: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
};

/** Everything a confirmation card needs: the server's pending action. */
export type Confirmation = Action;

/** Words written by the AI and fact-checked, or our own template when the check failed or AI is paused. */
export type AiWording = {
  text: string;
  /** Exactly what was sent to the AI, with personal details replaced by placeholders ("" when not kept). */
  redacted_input: string;
  ai_written: boolean;
};

export type ForecastPoint = { date: string; expected_minor: number; best_minor: number; worst_minor: number };

/** Days ahead ("7", "30", "60", "90") to the expected balance on that day. */
export type Horizons = Record<"7" | "30" | "60" | "90", number>;

export type LowPoint = { balance_minor: number; date: string };

// Cash (GET /api/cash)

export type CashAccount = {
  id: string;
  name: string;
  source: string;
  mask: string | null;
  currency: string;
  balance_minor: number;
  /** False for accounts in another currency: we hold no exchange rates, so they are left out of the total. */
  counted: boolean;
};

export type CashPosition = {
  currency: string;
  balance_minor: number;
  as_of: string;
  accounts: CashAccount[];
  /** The part of the total held by payment platforms rather than banks. */
  platform_minor: number;
  left_out: CashAccount[];
};

// Home (GET /api/home)

export type TodayItem = { id: string; sentence: string; action_label: string; href: string; level: ApprovalLevel; severity: Severity };

export type HomeSummary = {
  today: TodayItem[];
  /** `forecast` is the first 31 days of the forecast; `lowest` and `horizons` cover all 90. */
  cash: { balance_minor: number; as_of: string; forecast: ForecastPoint[]; lowest: LowPoint; horizons: Horizons };
  /** Bills due in the next 7 days (overdue ones included); `next_due_date` is the earliest of all unpaid bills. */
  bills_due: { count: number; total_minor: number; next_due_date: string | null };
  who_owes_you: { count: number; total_minor: number; overdue_minor: number };
  recommendations: { count: number; at_stake_minor: number };
};

// Inbox

export type InboxTab = "to_review" | "needs_approval" | "done";

/** A document the pipeline couldn't finish on its own. */
export type InboxDocument = {
  kind: "document";
  id: string;
  summary: string;
  reasons: string[];
  warnings: DocumentWarning[];
  created_at: string;
  level: ApprovalLevel;
  level_label: string;
};

export type InboxItem = InboxDocument | (Action & { kind?: undefined });

export type Inbox = { items: InboxItem[]; counts: { to_review: number; needs_approval: number } };

// Cash flow (GET /api/cash-flow, POST /api/cash-flow/what-if)

/**
 * Money going out in the forecast: unpaid bills (`bill:<id>`, the only ones that can be moved),
 * repeating payments, VAT and planned costs. `amount_minor` is positive.
 */
export type ForecastBill = { id: string; date: string; label: string; amount_minor: number; movable: boolean };

export type ForecastItem = {
  id: string;
  label: string;
  kind: "invoice" | "bill" | "repeating" | "tax" | "planned";
  /** Positive for money in, negative for money out. */
  amount_minor: number;
  /** null: left out of that case (an invoice long overdue counts only in the best case). */
  expected: string | null;
  best: string | null;
  worst: string | null;
  why: string;
  record_ids: string[];
};

export type CashWarning = {
  id: string;
  /** watch: worst case only; warning: expected case; urgent: within 7 days. */
  grade: "watch" | "warning" | "urgent";
  severity: Severity;
  sentence: string;
  why: string;
  date: string;
  days: number;
  balance_minor: number;
  item_ids: string[];
};

export type CashFlow = {
  today: string;
  currency: string;
  balance_minor: number;
  safety_level_minor: number;
  safety_level_why: string;
  lowest: LowPoint;
  worst_lowest: LowPoint;
  horizons: Horizons;
  series: ForecastPoint[];
  bills: ForecastBill[];
  items: ForecastItem[];
  repeating: { label: string; every: string; amount_minor: number; last: string; times: number }[];
  everyday_minor_per_week: number;
  warnings: CashWarning[];
  /** Items in other currencies that the forecast can't include. */
  left_out: { label: string; count: number }[];
};

export type PlanRepeat = "none" | "weekly" | "monthly";

/** A planned cost (or money in) for the what-if, or kept in the forecast. */
export type PlannedCost = { label: string; amount_minor: number; date: string; repeat?: PlanRepeat; direction?: "in" | "out" };
export type SavedPlan = Required<PlannedCost> & { id: string };

export type WhatIfInput = { planned: PlannedCost[]; excluded_bill_ids: string[]; moved_bills: { id: string; date: string }[] };

export type WhatIfResult = CashFlow & {
  what_if: {
    lowest_before: LowPoint;
    lowest_after: LowPoint;
    worst_lowest_after: LowPoint;
    below_safety: boolean;
    worst_below_safety: boolean;
    shortfall_minor: number;
    worst_shortfall_minor: number;
  };
};

// Why cash changed (GET /api/cash-flow/why)

export type WhyPeriod = "month" | "30d";

export type WhyReason = {
  group: string;
  label: string;
  /** This period's net minus last period's: positive means more cash. */
  change_minor: number;
  this_period_minor: number;
  last_period_minor: number;
  items: { label: string; change_minor: number }[];
  /** Customer payments only: invoices that fell due in each period and were still unpaid at its end. */
  late_this_period_minor?: number;
  late_last_period_minor?: number;
};

export type WhyCashChanged = {
  period: WhyPeriod;
  this_period: { from: string; to: string; net_minor: number };
  last_period: { from: string; to: string; net_minor: number };
  change_minor: number;
  reasons: WhyReason[];
  /** Our own sentence from the numbers. */
  sentence: string;
  explanation: AiWording;
};

// Business health (GET /api/business-health)

export type HealthCheck = { id: string; severity: Severity; sentence: string; why: string };

export type MonthResult = {
  month: string;
  /** "Apr 2026", "Apr 2026 (part)" when our records start part-way through, "Oct 2026 (so far)". */
  label: string;
  sales_minor: number;
  costs_minor: number;
  profit_minor: number;
  margin_pct: number | null;
  complete: boolean;
};

export type BusinessHealth = {
  /** The last three full months, e.g. "Jul 2026 to Sep 2026"; empty when there is no full month yet. */
  period_label: string;
  sales_minor: number;
  profit_minor: number;
  /** 0 when there were no sales in the period. */
  margin_pct: number;
  /** null when no invoice was paid in the last 90 days. */
  days_to_get_paid: number | null;
  /** null when more comes in than goes out. */
  runway_months: number | null;
  /** Average net cash flow a month over the last three months. */
  monthly_net_minor: number;
  profit_and_loss: MonthResult[];
  spending: { category: string; amount_minor: number }[];
  top_suppliers: { name: string; amount_minor: number }[];
  who_owes_you: { bucket: string; amount_minor: number }[];
  owed: { total_minor: number; count: number; overdue_minor: number; over_30_share: number; other_currencies: number };
  checks: HealthCheck[];
};

// Recommendations

export type RecommendationType =
  | "supplier_details_changed"
  | "bank_details_changed"
  | "price_rise"
  | "slow_payer"
  | "spending_creep"
  | "customer_concentration"
  | GettingPaidRecommendationType;

/** One before-and-after line; `before` is empty when there is nothing to compare with. */
export type Evidence = { label: string; before: string; after: string; record_id?: string };

export type RecommendationNextStep = {
  label: string;
  /** An email we can draft, a bank charge to record, or null for a step the person takes themselves. */
  kind: "email_supplier" | "send_payment_reminder" | "record_bank_charge" | null;
  href: string | null;
  can_draft: boolean;
  /** The drafted email's action, once there is one. */
  action: { id: string; status: ActionStatus } | null;
  /** Approvals already waiting about the same thing (changed bank details). */
  related_action_ids: string[];
};

export type Recommendation = {
  id: string;
  type: RecommendationType;
  title: string;
  summary: AiWording;
  severity: Severity;
  at_stake_minor: number | null;
  counterparty: string | null;
  counterparty_id: string | null;
  created_at: string;
  updated_at: string | null;
  status: "new" | "dismissed" | "done" | "resolved";
  why: string;
  evidence: Evidence[];
  next_step: RecommendationNextStep | null;
  /** False for changed bank details: a new change is always shown. */
  can_mute: boolean;
  /** Reminder stage or payment costs, for those two kinds only. */
  getting_paid?: GettingPaidDetail | null;
};

export type RecommendationsRun = { new: number; updated: number; resolved: number };

// Financing

export type FinancingOptionType = "supplier_terms" | "early_payment" | "credit_line" | "term_loan" | "invoice_finance" | "merchant_cash_advance";

/** The option's cost at the middle of its rate range, and what it does to the forecast. */
export type FinancingQuote = {
  amount_minor: number;
  months: number;
  total_cost_minor: number;
  /** Cost at the bottom and top of the rate range. */
  cost_range_minor: [number, number];
  monthly_repayment_minor: number;
  fee_minor: number;
  rate_pct: [number, number] | null;
  factor: [number, number] | null;
  yearly_cost_pct: number | null;
  closes_gap: boolean;
  /** When we time the money to arrive: the day before cash first dips, or tomorrow. */
  arrives_on?: string;
  lowest_minor: number;
  lowest_on: string;
  first_below_on: string | null;
  /** Plain words, e.g. "With this, cash stays above your safety level for the next 90 days." */
  forecast_effect: string;
};

/** The sliders: one option at a chosen amount and length, with the forecast it leads to. */
export type QuoteResult = FinancingQuote & {
  option_id: string;
  eligible: boolean;
  reasons: string[];
  series: { date: string; expected_minor: number }[];
};

export type FinancingOption = {
  id: string;
  type: FinancingOptionType;
  provider: string;
  product: string;
  free: boolean;
  min_minor: number;
  max_minor: number;
  min_months: number;
  max_months: number;
  about: string;
  /** The most this option can give this business. */
  limit_minor: number;
  eligible: boolean;
  /** Why not, as near misses where possible ("Available after 18 more months of trading."). */
  reasons: string[];
  eligibility_note: string | null;
  quote?: FinancingQuote & { covers_need: boolean };
};

export type FinancingGap = {
  amount_minor: number;
  starts_on: string;
  lowest_on: string;
  ends_on: string;
  days: number;
  months: number;
  safety_level_minor: number;
  lowest_minor: number;
  recovers: boolean;
};

export type ReadinessItem = { id: string; label: string; value: string; ok: boolean; tip: string | null };

export type ProfileField = {
  field: string;
  label: string;
  auto: number | null;
  value: number | null;
  corrected: boolean;
  corrected_by: string | null;
  corrected_at: string | null;
};

export type OwnerField = "industry" | "business_type" | "assets" | "credit_band" | "purpose" | "country";

export type BusinessProfile = {
  values: Record<string, unknown>;
  fields: ProfileField[];
  owner_fields: Record<OwnerField, string | null>;
  choices: { business_type: string[]; credit_band: string[]; purpose: string[] };
};

export type ProfileUpdate = { owner_fields?: Partial<Record<OwnerField, string | null>>; overrides?: Record<string, number | null> };

export type Financing = {
  gap: FinancingGap | null;
  need: { amount_minor: number | null; months: number | null; source: "you" | "forecast" | null };
  options: FinancingOption[];
  readiness: ReadinessItem[];
  profile: BusinessProfile;
  safety_level_minor: number;
  disclaimer: string;
  summary: AiWording;
  lender_pack: { available: boolean; can_share: boolean; approver: string };
};

// Documents

export type DocumentStatus = "received" | "queued" | "processing" | "review" | "awaiting_approval" | "approved" | "rejected";

export type DocumentWarning = { kind: string; label: string; detail?: string };

export type DocumentSummary = {
  id: string;
  filename: string;
  source: "email" | "upload" | "photo" | "statement";
  status: DocumentStatus;
  stage: string;
  stage_label: string;
  doc_type: string | null;
  counterparty: string | null;
  total_minor: number | null;
  currency: string;
  due_date: string | null;
  warnings: DocumentWarning[];
  created_at: string;
};

/** One processing step; a step can appear twice (started, then finished with a note). */
export type TimelineStep = { stage: string; label: string; at: string; ok: boolean; note?: string | null };

/** Where an extracted value sits on the original, as fractions of the page: [x0, y0, x1, y1]. */
export type Highlight = { field: string; page: number; box: [number, number, number, number] };

export type DocumentDetail = DocumentSummary & {
  /** The accepted form: plain strings, plus line items. */
  fields: Record<string, unknown>;
  timeline: TimelineStep[];
  review_reasons: string[];
  warnings: DocumentWarning[];
  /** Page count, once the text has been read. */
  pages: number | null;
  mime: string;
  sha256: string;
  sender_domain: string | null;
  sender_checks: Record<string, string>;
  /** Exactly what was sent to the AI, with personal details replaced by placeholders. */
  ai_saw: string | null;
  highlights: Highlight[];
  attempts: { attempt: number; role: string; model: string; passed: boolean; problems: string[]; provider: string | null }[];
  actions: Action[];
  record_id: string | null;
};

// Activity

export type ActivityEntry = {
  seq: number;
  at: string;
  /** "user:<id>", "ai:<step>", "system", "scheduler" or "webhooks". */
  actor: string;
  event: string;
  subject: string | null;
  details: Record<string, unknown> | null;
  /** Start of this entry's fingerprint. */
  hash: string;
};
export type Activity = { items: ActivityEntry[]; total: number };
export type ActivityCheck = { intact: boolean; entries: number; broken_at: number | null };

// Connections

export type ConnectionKind = "email" | "payments" | "bank" | "accounting";
export type ConnectionProvider = "mailpit" | "stripe" | "plaid" | "quickbooks";
export type Connection = {
  kind: ConnectionKind;
  provider: ConnectionProvider;
  provider_label: string;
  title: string;
  what: string;
  required: boolean;
  status: "connected" | "disconnected" | "expired" | "error";
  last_sync_at: string | null;
  /** Why the last sync failed, written for the person. */
  error: string | null;
  counts: Record<string, number> | null;
  /** The bills inbox address, for the email card. */
  address: string | null;
};
export type ConnectedAccount = { id: string; source: string; name: string; mask: string | null; currency: string; balance_minor: number; as_of: string };
export type Connections = { items: Connection[]; accounts: ConnectedAccount[] };
export type SyncResult = { ok: true; counts: Record<string, number>; matched: Record<string, number> };

// Ask

/** A chart or table our code builds from the records (never the AI). */
export type AskBlock =
  | { type: "chart"; kind: "forecast"; title: string; safety_level_minor: number; points: ForecastPoint[] }
  | { type: "table"; title: string; columns: string[]; rows: (string | number | null)[][]; money_columns: number[] }
  | AskPassagesBlock;

export type AskSuggestion = { type: "send_payment_reminder" | "email_supplier"; counterparty_id: string; label: string };

type AnswerParts = {
  answer: AiWording;
  blocks: AskBlock[];
  sources: RecordRef[];
  follow_ups: string[];
  /** An email the assistant suggests; it becomes a draft only when clicked. */
  suggestion: AskSuggestion | null;
};

export type AskReply = AnswerParts & { id: string; thread_id: string };

export type AskMessage =
  | { id: string; role: "user"; created_at: string; text: string }
  | (AnswerParts & { id: string; role: "assistant"; created_at: string; checked: boolean });

export type AskThreadSummary = { id: string; title: string; created_at: string };
export type AskThread = { id: string; title: string; messages: AskMessage[] };

// Phone handoff

export type Handoff = { id: string; url: string; expires_at: string; max_uploads: number };
export type HandoffStatus = { id: string; expires_at: string; expired: boolean; received: { id: string; filename: string; status: string }[] };
/** What the phone's upload page shows. */
export type HandoffPage = { business: string; expires_at: string; left: number };

// Notifications and search

export type Notification = { id: string; kind: string; title: string; link: string | null; created_at: string; read: boolean };
export type SearchResult = { id: string; kind: string; label: string; href: string };

// Settings

export type TeamMember = { id: string; name: string; email: string; roles: Role[]; approval_limit_minor: number | null; second_approver: boolean };

// Learning from decisions

/** A value we filled in from past corrections, shown beside the field with Undo. */
export type LearnedField = {
  value: string;
  /** What the AI read, which Undo puts back. */
  ai_value: string;
  corrections: number;
  learned_as: "category_hint" | "doc_type" | "currency" | "payment_terms" | "counterparty_name";
  /** The person changed it afterwards. */
  undone: boolean;
};

export type DocumentWithLearning = DocumentDetail & { learned?: Record<string, LearnedField> };

/** A kind acted on rarely is folded under "Less useful to you". Urgent ones never are. */
export type RankedRecommendation = Recommendation & { less_useful?: boolean };

export type LearnedItem = { field: LearnedField["learned_as"]; label: string; value: string | number; value_label: string; corrections: number; sentence: string };

export type LearnedKind = { kind: string; label: string; acted_on: number; turned_down: number; decisions: number; acted_share: number; less_useful: boolean; sentence: string };

export type LearningSummary = {
  suppliers: { counterparty_id: string; name: string; kind: "supplier" | "customer"; items: LearnedItem[] }[];
  recommendations: LearnedKind[];
  numbers: {
    fields_filled: number;
    fields_kept: number;
    fields_undone: number;
    documents_helped: number;
    seconds_per_field: number;
    minutes_saved: number;
    decisions: number;
    acted_on: number;
    acted_share: number | null;
    top_decisions: number;
    top_acted_on: number;
    top_acted_share: number | null;
  };
  rules: { learn_after: number; fold_after: number; fold_below: number };
  assumptions: string[];
  never_learned: string[];
  can_reset: boolean;
};

export type LearningReset =
  | { scope: "all" }
  | { scope: "supplier"; counterparty_id: string }
  | { scope: "field"; counterparty_id: string; field: LearnedField["learned_as"] }
  | { scope: "kind"; kind: string };

// Getting paid (backend/app/analytics/getting_paid.py and api/payments.py)

export type GettingPaidRecommendationType = "payment_costs" | "chase_overdue";

export type PaymentMethod = "card" | "bank_transfer" | "international_transfer" | "cash" | "unknown";

/** One way of paying over the last 180 days. The card fee is what card would have cost (or did cost). */
export type PaymentMethodRow = {
  method: PaymentMethod;
  label: string;
  payments: number;
  amount_minor: number;
  short_minor: number;
  short_payments: number;
  card_fee_minor: number;
  card_fee_is_estimate: boolean;
  days_to_pay: number;
};

/** "yours": this business's own card fees; "typical": a stated typical rate, used until there are enough. */
export type CardRate = { rate: number; fixed_minor: number; source: "yours" | "typical"; label: string; payments: number };

export type ReminderLink = "card_link" | "invoice_page" | "none";

export type ReminderDetail = {
  reminder: {
    stage: 1 | 2 | 3;
    of: number;
    tone: "friendly" | "firm" | "final notice";
    invoices: { record_id: string; reference: string | null; open_minor: number; due: string; days_overdue: number; link: ReminderLink }[];
    /** A final notice: only a business owner approves it. */
    owner_only: boolean;
    previous: { stage: number; sent_on: string }[];
    link: "all" | "some" | "none";
    links_configured: boolean;
  };
};

export type PaymentCostsDetail = {
  methods: PaymentMethodRow[];
  card_rate: CardRate;
  main_method: PaymentMethod;
  short_minor: number;
  short_payments: number;
  card_fee_minor: number;
  saving_minor: number;
  days_sooner_by_card: number | null;
  leftovers: { record_id: string; reference: string | null; short_minor: number }[];
  leftover_minor: number;
  links_configured: boolean;
  tip: string;
};

export type GettingPaidDetail = ReminderDetail | PaymentCostsDetail;

/** What getting paid cost and how long it took, over the last 180 days. */
export type GettingPaid = {
  since: string;
  days: number;
  lost_to_short_minor: number;
  short_payments: number;
  could_save_minor: number;
  days_to_pay_by_card: number | null;
  days_to_pay_by_transfer: number | null;
  days_sooner_by_card: number | null;
  left_to_record_minor: number;
  left_to_record_count: number;
  methods: PaymentMethodRow[];
  card_rate: CardRate;
  /** The rate used for customers who pay from abroad (the same as card_rate when it is the business's own). */
  card_rate_abroad: CardRate;
  /** Stage 0: paid before any reminder. */
  paid_after_reminder: { stage: number; invoices: number; amount_minor: number; days_to_pay: number }[];
  links_configured: boolean;
  links_problem: string | null;
};

// Ask anything

/** A passage from a document that matched a search. Personal details show as [hidden …]. */
export type AskPassage = { document_id: string; label: string; kind: string; date: string; text: string; href: string };
export type AskPassagesBlock = { type: "passages"; title: string; items: AskPassage[] };

/** This person's own questions: answered from our records, and passed the fact check first time. */
export type AskStats = {
  questions: number;
  answered_from_data: number;
  checked_first_try: number;
  first_try_pct: number | null;
  by_tool: Record<string, number>;
};
