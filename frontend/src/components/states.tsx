import { CircleAlertIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center", className)}>
      <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </span>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Says what happened (the server's own words) and what to do next. */
export function ErrorState({ message, onRetry, action, className }: { message: string; onRetry?: () => void; action?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft/50 p-5 sm:flex-row sm:items-center", className)}>
      <CircleAlertIcon className="size-5 shrink-0 text-danger" aria-hidden />
      <div className="flex-1">
        <p className="text-sm font-medium">{message}</p>
        {onRetry && <p className="text-sm text-muted-foreground">Try again. If it keeps happening, check Connections or sign in again.</p>}
      </div>
      {action}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden /> Try again
        </Button>
      )}
    </div>
  );
}

/** Inline form error, announced to screen readers. */
export function FormError({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive" className="min-h-0">
      {message && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft/60 px-3 py-2 text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
