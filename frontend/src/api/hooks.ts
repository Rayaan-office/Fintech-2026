import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiOptional } from "./client";
import type {
  Activity,
  AskReply,
  BusinessHealth,
  CashFlow,
  Connection,
  DocumentDetail,
  DocumentSummary,
  Financing,
  FinancingQuote,
  Handoff,
  HomeSummary,
  Inbox,
  Notification,
  Receipt,
  Recommendation,
  SearchResult,
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
export const useInbox = (enabled = true) => useScreen<Inbox>(["inbox"], "/api/inbox", enabled);
export const useCashFlow = () => useScreen<CashFlow>(["cash-flow"], "/api/cash-flow");
export const useBusinessHealth = () => useScreen<BusinessHealth>(["business-health"], "/api/business-health");
export const useRecommendations = () => useScreen<{ items: Recommendation[] }>(["recommendations"], "/api/recommendations");
export const useFinancing = () => useScreen<Financing>(["financing"], "/api/financing");
export const useDocuments = () => useScreen<{ items: DocumentSummary[] }>(["documents"], "/api/documents");
export const useActivity = () => useScreen<Activity>(["activity"], "/api/activity");
export const useConnections = () => useScreen<{ items: Connection[] }>(["connections"], "/api/connections");
export const useMyReceipts = () => useScreen<{ items: Receipt[] }>(["receipts", "mine"], "/api/receipts/mine");
export const useNotifications = (enabled: boolean) => useScreen<{ items: Notification[] }>(["notifications"], "/api/notifications", enabled);
export const useTeam = (enabled: boolean) => useScreen<{ items: TeamMember[] }>(["team"], "/api/team", enabled);

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: ["documents", id],
    queryFn: ({ signal }) => apiOptional<DocumentDetail>(`/api/documents/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: Boolean(id),
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

export function useApproveAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (actionId: string) =>
      api<{ status: "done" | "waiting_for_second_approval"; message: string }>(`/api/actions/${encodeURIComponent(actionId)}/approve`, { method: "POST" }),
    onSuccess: () => invalidate("inbox", "home", "activity", "recommendations", "documents"),
  });
}

export function useCancelAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (actionId: string) => api<{ ok: true }>(`/api/actions/${encodeURIComponent(actionId)}/cancel`, { method: "POST" }),
    onSuccess: () => invalidate("inbox", "home", "activity"),
  });
}

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
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<DocumentSummary>("/api/documents", { method: "POST", body: form });
    },
    onSuccess: () => invalidate("documents", "inbox"),
  });
}

export function useSubmitReceipt() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<Receipt>("/api/receipts", { method: "POST", body: form });
    },
    onSuccess: () => invalidate("receipts"),
  });
}

export function useCreateHandoff() {
  return useMutation({ mutationFn: () => api<Handoff>("/api/handoff", { method: "POST" }) });
}

export function useReconnect() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ redirect_url: string | null }>(`/api/connections/${encodeURIComponent(id)}/reconnect`, { method: "POST" }),
    onSuccess: () => invalidate("connections"),
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
    mutationFn: (paused: boolean) => api<{ ai_paused: boolean }>("/api/business/ai-pause", { method: "POST", body: { paused } }),
    onSuccess: () => invalidate("me"),
  });
}
