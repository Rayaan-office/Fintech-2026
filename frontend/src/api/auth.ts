import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { LoginResult, Me, Permission, TotpSetup } from "./types";

export const meKey = ["me"] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: ({ signal }) => api<Me>("/api/auth/me", { signal }),
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });
}

/** Only call inside the signed-in shell, where `me` is guaranteed to be loaded. */
export function useCurrentUser(): Me {
  const { data } = useMe();
  if (!data) throw new Error("useCurrentUser used outside the signed-in app");
  return data;
}

export function useCan() {
  const me = useCurrentUser();
  return (perm: Permission) => me.permissions.includes(perm);
}

// A fresh session: drop any cached "not signed in" answer so the guard asks again
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api<LoginResult>("/api/auth/login", { method: "POST", body }),
    onSuccess: () => qc.removeQueries({ queryKey: meKey }),
  });
}

/** Generates a new secret on the server, so it is fetched once and never refetched. */
export function useTotpSetup(enabled: boolean) {
  return useQuery({
    queryKey: ["totp-setup"],
    queryFn: () => api<TotpSetup>("/api/auth/totp/setup", { method: "POST" }),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useTotpVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api<{ ok: true }>("/api/auth/totp/verify", { method: "POST", body: { code } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["totp-setup"] });
      qc.removeQueries({ queryKey: meKey });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSettled: () => qc.clear(),
  });
}
