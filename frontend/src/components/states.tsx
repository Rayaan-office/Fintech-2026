import { CircleAlertIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconTile } from "./kit";
import { Button } from "./ui/button";

/** Nothing here yet: an icon, a few words and the next step. No box around it. */
export function EmptyState({
  icon,
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
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <IconTile icon={icon} className="mb-4 size-11 [&>svg]:size-5" />
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Says what happened (the server's own words) and what to do next. */
export function ErrorState({ message, onRetry, action, className }: { message: string; onRetry?: () => void; action?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-xl bg-danger-soft/60 px-4 py-3.5 sm:flex-row sm:items-center", className)}>
      <IconTile icon={CircleAlertIcon} tone="danger" className="bg-card" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{message}</p>
        {onRetry && <p className="text-[13px] text-muted-foreground">If it keeps happening, check Connections or sign in again.</p>}
      </div>
      {action}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
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
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft/70 px-3 py-2 text-sm">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span>{message}</span>
        </p>
      )}
    </div>
  );
}
