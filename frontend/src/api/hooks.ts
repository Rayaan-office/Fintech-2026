import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiOptional } from "./client";
import type {
  Action,
  Activity,
  ActivityCheck,
  AskReply,
  BusinessHealth,
  CashFlow,
  ConnectionProvider,
  Connections,
  DocumentDetail,
  DocumentSummary,
  Financing,
  FinancingQuote,
  Handoff,
  HomeSummary,
  Inbox,
  InboxTab,
  Notification,
  Recommendation,
  SearchResult,
  SyncResult,
  TeamMember,
} from "./types";

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
export const useCashFlow = () => useScreen<CashFlow>(["cash-flow"], "/api/cash-flow");
export const useBusinessHealth = () => useScreen<BusinessHealth>(["business-health"], "/api/business-health");
export const useRecommendations = () => useScreen<{ items: Recommendation[] }>(["recommendations"], "/api/recommendations");
export const useFinancing = () => useScreen<Financing>(["financing"], "/api/financing");
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

export type WhatIf = { planned: { label: string; amount_minor: number; date: string }[]; excluded_bill_ids: string[] };

/** The forecast re-run with planned costs added and chosen bills left out. */
export function useWhatIf(scenario: WhatIf | null) {
  return useQuery({
    queryKey: ["cash-flow", "what-if", scenario],
    queryFn: ({ signal }) => apiOptional<CashFlow>("/api/cash-flow/what-if", { method: "POST", body: scenario, signal }),
    enabled: scenario !== null,
    placeholderData: keepPreviousData,
  });
}

export function useFinancingQuote(input: { option_id: string; amount_minor: number; months: number } | null) {
  return useQuery({
    queryKey: ["financing-quote", input],
    queryFn: ({ signal }) => apiOptional<FinancingQuote>("/api/financing/quote", { method: "POST", body: input, signal }),
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
    onSettled: () => invalidate("inbox", "home", "activity", "recommendations", "documents"),
  });
}

/** Answers with the action: "executed" when done, still "pending" when a second person must approve. */
export const useApproveAction = () => useActionMutation("approve");
export const useRejectAction = () => useActionMutation("reject");
export const useCancelAction = () => useActionMutation("cancel");
export const useUndoAction = () => useActionMutation("undo");

export function useDismissRecommendation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/recommendations/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
    onSuccess: () => invalidate("recommendations", "home"),
  });
}

export function useAsk() {
  return useMutation({
    mutationFn: (question: string) => api<AskReply>("/api/ask", { method: "POST", body: { question } }),
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

export function useCreateHandoff() {
  return useMutation({ mutationFn: () => api<Handoff>("/api/handoff", { method: "POST" }) });
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
    onSettled: () => invalidate("connections", "activity", "documents", "inbox"),
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
