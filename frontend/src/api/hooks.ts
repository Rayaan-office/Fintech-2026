import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiOptional } from "./client";
import type {
  Action,
  Activity,
  ActivityCheck,
  AskReply,
  AskThread,
  AskThreadSummary,
  BusinessProfile,
  BusinessHealth,
  CashFlow,
  CashPosition,
  ConnectionProvider,
  Connections,
  DocumentDetail,
  DocumentSummary,
  Financing,
  Handoff,
  HandoffPage,
  HandoffStatus,
  HomeSummary,
  Inbox,
  InboxTab,
  Notification,
  PlannedCost,
  ProfileUpdate,
  QuoteResult,
  Recommendation,
  RecommendationsRun,
  SavedPlan,
  SearchResult,
  SyncResult,
  TeamMember,
  WhatIfInput,
  WhatIfResult,
  WhyCashChanged,
  WhyPeriod,
} from "./types";
import type { LearningReset, LearningSummary } from "./types";

/*
 * One hook per screen. Each resolves to `null` when the server has nothing for that screen
 * (404), which the page renders as its empty state.
 */

function useScreen<T>(key: readonly unknown[], path: string, enabled = true) {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiOptional<T>(path, { signal }),
    enabled,
  });
}

export const useHome = () => useScreen<HomeSummary>(["home"], "/api/home");
/** Each tab is its own request; every answer also carries the counts for the tab badges. */
export const useInbox = (tab: InboxTab, enabled = true) => useScreen<Inbox>(["inbox", tab], `/api/inbox?tab=${tab}&limit=100`, enabled);
export const useCash = () => useScreen<CashPosition>(["cash"], "/api/cash");
export const useCashFlow = () => useScreen<CashFlow>(["cash-flow"], "/api/cash-flow");
/** The numbers behind the change and a short explanation the AI writes from them only. Kept under "cash-flow" so it refreshes with the forecast. */
export function useWhyCashChanged(period: WhyPeriod) {
  return useQuery({
    queryKey: ["cash-flow", "why", period],
    queryFn: ({ signal }) => apiOptional<WhyCashChanged>(`/api/cash-flow/why?period=${period}`, { signal }),
    placeholderData: keepPreviousData,
  });
}
export const usePlannedItems = () => useScreen<{ items: SavedPlan[] }>(["cash-flow", "planned"], "/api/planned-items");
export const useBusinessHealth = () => useScreen<BusinessHealth>(["business-health"], "/api/business-health");
export const useRecommendations = () => useScreen<{ items: Recommendation[] }>(["recommendations"], "/api/recommendations");

export type FinancingAsk = { amount_minor?: number; months?: number; purpose?: string };

/** Options for the forecast's shortfall, or for an amount and purpose the person chose. */
export function useFinancing(ask: FinancingAsk = {}) {
  const q = new URLSearchParams();
  if (ask.amount_minor) q.set("amount_minor", String(ask.amount_minor));
  if (ask.months) q.set("months", String(ask.months));
  if (ask.purpose) q.set("purpose", ask.purpose);
  const query = q.toString();
  return useQuery({
    queryKey: ["financing", "options", ask],
    queryFn: ({ signal }) => apiOptional<Financing>(`/api/financing${query ? `?${query}` : ""}`, { signal }),
    placeholderData: keepPreviousData,
  });
}
/** Employees get only the documents they sent in; the server filters. */
export const useDocuments = () => useScreen<{ items: DocumentSummary[] }>(["documents", "list"], "/api/documents?limit=200");
export const useActivityCheck = () => useScreen<ActivityCheck>(["activity", "verify"], "/api/activity/verify");
export const useConnections = () => useScreen<Connections>(["connections"], "/api/connections");
export const useNotifications = (enabled: boolean) => useScreen<{ items: Notification[] }>(["notifications"], "/api/notifications", enabled);
export const useTeam = (enabled: boolean) => useScreen<{ items: TeamMember[] }>(["team"], "/api/team", enabled);

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: ["documents", id],
    queryFn: ({ signal }) => apiOptional<DocumentDetail>(`/api/documents/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: Boolean(id),
  });
}

const ACTIVITY_PAGE = 100;

/** Newest first, a page at a time. `actor` is a prefix such as "user:" or "ai:". */
export function useActivity(filter: { actor?: string; event?: string }) {
  return useInfiniteQuery({
    queryKey: ["activity", "list", filter],
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ limit: String(ACTIVITY_PAGE), offset: String(pageParam) });
      if (filter.actor) q.set("actor", filter.actor);
      if (filter.event) q.set("event", filter.event);
      return api<Activity>(`/api/activity?${q}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.items.length < ACTIVITY_PAGE ? undefined : pages.length * ACTIVITY_PAGE),
    placeholderData: keepPreviousData,
  });
}

/** The forecast re-run with planned costs added and bills left out or moved. Nothing is saved; real records never change. */
export function useWhatIf(scenario: WhatIfInput | null) {
  return useQuery({
    queryKey: ["cash-flow", "what-if", scenario],
    queryFn: ({ signal }) => api<WhatIfResult>("/api/cash-flow/what-if", { method: "POST", body: scenario, signal }),
    enabled: scenario !== null,
    placeholderData: keepPreviousData,
  });
}

export function useFinancingQuote(input: { option_id: string; amount_minor: number; months: number } | null) {
  return useQuery({
    queryKey: ["financing", "quote", input],
    queryFn: ({ signal }) => apiOptional<QuoteResult>("/api/financing/quote", { method: "POST", body: input, signal }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
  });
}

/** POST so search terms (often customer or supplier names) stay out of URLs and access logs. */
export function useSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ["search", term],
    queryFn: ({ signal }) => apiOptional<{ results: SearchResult[] }>("/api/search", { method: "POST", body: { q: term }, signal }),
    enabled: term.length >= 2,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

// Actions. Every change goes through a pending action that the server checks for level and role.

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

const actionPath = (id: string, verb: string) => `/api/actions/${encodeURIComponent(id)}/${verb}`;

function useActionMutation(verb: "approve" | "reject" | "cancel" | "undo") {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (actionId: string) => api<Action>(actionPath(actionId, verb), { method: "POST" }),
    // An approved bill, payment or match changes the forecast and the health numbers too
    onSettled: () => invalidate("inbox", "home", "activity", "recommendations", "documents", "cash", "cash-flow", "business-health"),
  });
}

/** Answers with the action: "executed" when done, still "pending" when a second person must approve. */
export const useApproveAction = () => useActionMutation("approve");
export const useRejectAction = () => useActionMutation("reject");
export const useCancelAction = () => useActionMutation("cancel");
export const useUndoAction = () => useActionMutation("undo");

const recPath = (id: string, verb: string) => `/api/recommendations/${encodeURIComponent(id)}/${verb}`;

/** `mute` also stops that kind for that supplier or customer; the server ignores it for changed bank details. */
export function useDismissRecommendation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, mute }: { id: string; mute: boolean }) => api<{ ok: true; muted: boolean }>(recPath(id, "dismiss"), { method: "POST", body: { mute } }),
    onSuccess: () => invalidate("recommendations", "home"),
  });
}

/** Look again now instead of waiting for new data or the daily run. */
export function useRefreshRecommendations() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api<RecommendationsRun>("/api/recommendations/refresh", { method: "POST" }),
    onSuccess: () => invalidate("recommendations", "home"),
  });
}

/** Drafts the suggested email (or returns the draft already waiting). Nothing is sent until someone approves. */
export function useDraftNextStep() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ action: Action }>(recPath(id, "next-step"), { method: "POST" }),
    onSuccess: () => invalidate("recommendations", "inbox"),
  });
}

/** Owners correct automatic values (null puts one back) and add what only they know. */
export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: ProfileUpdate) => api<BusinessProfile>("/api/business-profile", { method: "PUT", body: update }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["financing"] }),
  });
}

/** Prepares the pack now and asks a business owner to approve sending exactly that PDF. */
export function useShareLenderPack() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (to: { lender_name: string; email: string }) => api<{ action: Action }>("/api/lender-pack/share", { method: "POST", body: to }),
    onSuccess: () => invalidate("inbox", "activity"),
  });
}

// Ask. Each person sees only their own conversations.

export const useAskThreads = () => useScreen<{ items: AskThreadSummary[] }>(["ask", "threads"], "/api/ask/threads");

/** A conversation's messages. Only this person adds to it, and each answer is added to the cache as it arrives. */
export function useAskThread(id: string | null) {
  return useQuery({
    queryKey: ["ask", "thread", id],
    queryFn: ({ signal }) => api<AskThread>(`/api/ask/threads/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

export function useAsk() {
  return useMutation({
    mutationFn: (input: { question: string; thread_id?: string | null }) =>
      api<AskReply>("/api/ask", { method: "POST", body: { question: input.question, ...(input.thread_id ? { thread_id: input.thread_id } : {}) } }),
  });
}

/** Deletes one of your own conversations. */
export function useDeleteAskThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/ask/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: ["ask", "thread", id] });
      void qc.invalidateQueries({ queryKey: ["ask", "threads"] });
      void qc.invalidateQueries({ queryKey: ["ask", "stats"] });
    },
  });
}

/** Turns the assistant's suggestion into a draft email that waits for approval. */
export function useAskAct() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (messageId: string) => api<{ action: Action }>(`/api/ask/messages/${encodeURIComponent(messageId)}/act`, { method: "POST" }),
    onSuccess: () => invalidate("inbox"),
  });
}

export function useUploadDocument() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ file, source = "upload" }: { file: File; source?: "upload" | "photo" }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("source", source);
      return api<{ id: string }>("/api/documents", { method: "POST", body: form });
    },
    onSuccess: () => invalidate("documents", "inbox"),
  });
}

/** A person corrects what was read. A document waiting for review then goes for approval. */
export function useCorrectFields(documentId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (fields: Record<string, string>) =>
      api<DocumentDetail>(`/api/documents/${encodeURIComponent(documentId)}/fields`, { method: "POST", body: { fields } }),
    onSuccess: () => invalidate("documents", "inbox", "activity"),
  });
}

export function useReprocessDocument(documentId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/documents/${encodeURIComponent(documentId)}/reprocess`, { method: "POST" }),
    onSuccess: () => invalidate("documents", "inbox"),
  });
}

/** Keeps a planned cost in the forecast for everyone until someone removes it. Real records are not changed. */
export function useAddPlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (plan: PlannedCost) => api<SavedPlan>("/api/planned-items", { method: "POST", body: plan }),
    onSuccess: () => invalidate("cash-flow", "home", "financing", "activity"),
  });
}

export function useRemovePlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/planned-items/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidate("cash-flow", "home", "financing", "activity"),
  });
}

export function useCreateHandoff() {
  return useMutation({ mutationFn: () => api<Handoff>("/api/handoff", { method: "POST" }) });
}

/** The computer watches what arrives from the phone while the QR code is open. */
export function useHandoffStatus(id: string | null) {
  return useQuery({
    queryKey: ["handoff", id],
    queryFn: ({ signal }) => api<HandoffStatus>(`/api/handoff/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.expired ? false : 2000),
  });
}

// The phone's side: no session, the link is the key

export function useHandoffPage(token: string) {
  return useQuery({
    queryKey: ["handoff-page", token],
    queryFn: ({ signal }) => api<HandoffPage>(`/api/handoff/upload/${encodeURIComponent(token)}`, { signal }),
    retry: false,
  });
}

export function usePhoneUpload(token: string) {
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<{ id: string; left: number }>(`/api/handoff/upload/${encodeURIComponent(token)}`, { method: "POST", body });
    },
  });
}

// Connections. Connecting reads everything once, so these can take a few seconds.

const connectionPath = (provider: ConnectionProvider, verb: string) => `/api/connections/${provider}/${verb}`;

/** Stripe and the Plaid sandbox connect with one call. QuickBooks goes through Intuit's sign-in page instead. */
export function useConnect() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (provider: "stripe" | "plaid") => api<SyncResult>(connectionPath(provider, "connect"), { method: "POST" }),
    onSettled: () => invalidate("connections", "activity"),
  });
}

export function useSync() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (provider: ConnectionProvider) => api<SyncResult>(connectionPath(provider, "sync"), { method: "POST" }),
    onSettled: () => invalidate("connections", "activity", "documents", "inbox", "home", "cash", "cash-flow", "business-health"),
  });
}

export function useDisconnect() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (provider: ConnectionProvider) => api<{ ok: true }>(connectionPath(provider, "disconnect"), { method: "POST" }),
    onSettled: () => invalidate("connections", "activity"),
  });
}

export function useMarkNotificationsRead() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/notifications/read", { method: "POST" }),
    onSuccess: () => invalidate("notifications", "me"),
  });
}

export function useSetAiPaused() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (paused: boolean) => api<{ ai_paused: boolean }>("/api/settings/ai-pause", { method: "POST", body: { paused } }),
    onSuccess: () => invalidate("me"),
  });
}

// Learning from decisions

export const useLearning = () => useScreen<LearningSummary>(["learning"], "/api/learning");

/** Owners only. Corrections stay in the history; we just stop learning from them. */
export function useResetLearning() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (what: LearningReset) => api<LearningSummary>("/api/learning/reset", { method: "POST", body: what }),
    onSuccess: () => invalidate("learning", "recommendations", "activity"),
  });
}

/** Opening the page a recommendation points to counts as acting on it. */
export function useFollowRecommendation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(recPath(id, "followed"), { method: "POST" }),
    onSuccess: () => invalidate("learning"),
  });
}

// Getting paid

export const useGettingPaid = () => useScreen<import("./types").GettingPaid>(["getting-paid"], "/api/getting-paid");

/** Prepares recording what arrived short as bank charges; a finance manager or owner approves it. */
export function useRecordBankCharge() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (recId: string) => api<{ action: Action }>(recPath(recId, "bank-charge"), { method: "POST" }),
    onSuccess: () => invalidate("recommendations", "inbox", "getting-paid"),
  });
}

// Ask anything

import type { AskStats } from "./types";

export const useAskStats = () => useScreen<AskStats>(["ask", "stats"], "/api/ask/stats");
