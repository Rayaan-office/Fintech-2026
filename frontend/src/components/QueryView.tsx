import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { PageSkeleton } from "./skeletons";
import { ErrorState } from "./states";

/** Loading → skeleton, error → explained error, null (404) → the screen's empty state. */
export function QueryView<T>({
  query,
  loading = <PageSkeleton />,
  empty,
  children,
}: {
  query: UseQueryResult<T | null>;
  loading?: ReactNode;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{loading}</>;
  if (query.isError) return <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
  if (query.data === null) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
