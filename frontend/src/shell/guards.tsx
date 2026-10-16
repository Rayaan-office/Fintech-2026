import { LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useCurrentUser, useMe } from "@/api/auth";
import { ApiError, errorMessage, TWO_STEP_REQUIRED } from "@/api/client";
import type { Permission } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { startPath } from "./nav";

/** Signed-in area. Sends people to sign in, or to the two-step screen when that's still pending. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <ShellSkeleton />;
  if (me.isError) {
    const err = me.error;
    if (err instanceof ApiError && err.status === 401) {
      if (err.detail === TWO_STEP_REQUIRED) return <Navigate to="/sign-in/two-step" replace />;
      return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
    }
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState message={errorMessage(err)} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return <Outlet />;
}

/** A page the current person's role may not include. Home falls back to their own start page. */
export function RequirePerm({ perm, children }: { perm: Permission | null; children: ReactNode }) {
  const me = useCurrentUser();
  const location = useLocation();
  if (!perm || me.permissions.includes(perm)) return <>{children}</>;
  const start = startPath(me);
  if (location.pathname === "/" && start !== "/") return <Navigate to={start} replace />;
  return (
    <EmptyState
      icon={LockIcon}
      title="This page isn't part of your role"
      description="Ask the business owner if you need access."
      action={
        <Button asChild variant="secondary">
          <Link to={start}>Go to my start page</Link>
        </Button>
      }
    />
  );
}

export function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 flex-col gap-2 border-r bg-sidebar p-4 md:flex">
        <Skeleton className="mb-6 h-8 w-36" />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
      <div className="flex-1">
        <div className="flex h-14 items-center border-b px-6">
          <Skeleton className="h-9 w-72" />
        </div>
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
