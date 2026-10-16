import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      // A session that expired mid-visit: re-check who is signed in, and the guard sends them to sign in
      onError: (error, query) => {
        if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== "me") {
          void client.invalidateQueries({ queryKey: ["me"] });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ["me"] });
      },
    }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
  return client;
}
