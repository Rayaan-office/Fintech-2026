import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, className }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The one headline number a page leads with. */
export function Headline({ label, value, note, className }: { label: ReactNode; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1", className)}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-3xl font-semibold tracking-tight tabular sm:text-4xl">{value}</div>
      {note && <div className="text-sm text-muted-foreground">{note}</div>}
    </div>
  );
}

export function SummaryCard({ label, value, note, footer, className }: { label: ReactNode; value: ReactNode; note?: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col rounded-xl border bg-card shadow-card", className)}>
      <div className="flex-1 p-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular">{value}</div>
        {note && <div className="mt-1 text-sm text-muted-foreground">{note}</div>}
      </div>
      {footer && <div className="border-t px-5 py-2.5 text-sm">{footer}</div>}
    </div>
  );
}
