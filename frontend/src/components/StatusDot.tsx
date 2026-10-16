import { cn } from "@/lib/utils";

export type Status = "positive" | "warning" | "danger" | "neutral" | "accent";

const colours: Record<Status, string> = {
  positive: "bg-positive",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted-foreground/50",
  accent: "bg-primary",
};

/** Colour is never the only signal: always pass a label (shown or screen-reader only). */
export function StatusDot({ status, label, showLabel = false, pulse = false, className }: { status: Status; label: string; showLabel?: boolean; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <span className="relative flex size-2">
        {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", colours[status])} />}
        <span className={cn("relative inline-flex size-2 rounded-full", colours[status])} aria-hidden />
      </span>
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
    </span>
  );
}
