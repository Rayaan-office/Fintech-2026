/** Small pieces of a document row: its kind, where it came from, its status and warnings. */
import {
  BanknoteIcon,
  CameraIcon,
  FileMinusIcon,
  FileTextIcon,
  LandmarkIcon,
  MailIcon,
  ReceiptIcon,
  ReceiptTextIcon,
  SendIcon,
  TriangleAlertIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { DocumentSummary } from "@/api/types";
import { DOCUMENT_STATUS, isReading, ReadingStatus, stageProgress } from "@/components/DocumentReview";
import { StatusDot } from "@/components/StatusDot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const DOC_KIND: Record<string, { label: string; long: string; icon: LucideIcon }> = {
  bill: { label: "Bill", long: "A bill to pay", icon: ReceiptTextIcon },
  invoice: { label: "Invoice", long: "An invoice we sent", icon: SendIcon },
  receipt: { label: "Receipt", long: "A receipt for something paid", icon: ReceiptIcon },
  payment_notice: { label: "Payment", long: "A payment notice", icon: BanknoteIcon },
  credit_note: { label: "Credit", long: "A credit note", icon: FileMinusIcon },
  statement: { label: "Statement", long: "A bank statement", icon: LandmarkIcon },
  other: { label: "Other", long: "Another kind of document", icon: FileTextIcon },
};

export const DOC_SOURCE: Record<DocumentSummary["source"], { label: string; icon: LucideIcon }> = {
  email: { label: "Arrived by email", icon: MailIcon },
  upload: { label: "Uploaded", icon: UploadIcon },
  photo: { label: "Photo from a phone", icon: CameraIcon },
  statement: { label: "From a bank statement", icon: LandmarkIcon },
};

export const kindOf = (d: Pick<DocumentSummary, "doc_type" | "source">) =>
  DOC_KIND[d.doc_type ?? ""] ?? (d.source === "statement" ? DOC_KIND.statement! : null);

/** A hover tip on something that isn't a button, still reachable by keyboard. */
export function Tip({ tip, children, className }: { tip: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("inline-flex rounded outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} onClick={(e) => e.stopPropagation()}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** "Bill" with its icon; "Reading…" before we know. */
export function TypeChip({ doc }: { doc: Pick<DocumentSummary, "doc_type" | "source" | "status"> }) {
  const kind = kindOf(doc);
  if (!kind) return <span className="text-xs text-muted-foreground">{isReading(doc.status) ? "…" : "—"}</span>;
  const Icon = kind.icon;
  return (
    <Tip tip={kind.long}>
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {kind.label}
      </span>
    </Tip>
  );
}

/** Where it came from, as an icon with a tip. */
export function SourceIcon({ source }: { source: DocumentSummary["source"] }) {
  const s = DOC_SOURCE[source] ?? { label: source, icon: FileTextIcon };
  const Icon = s.icon;
  return (
    <Tip tip={s.label} className="text-muted-foreground">
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{s.label}</span>
    </Tip>
  );
}

/** Warnings as one small count; the tip lists them. */
export function WarningsChip({ warnings, plain = false }: { warnings: DocumentSummary["warnings"]; plain?: boolean }) {
  if (warnings.length === 0) return null;
  const chip = (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger tabular">
      <TriangleAlertIcon className="size-3.5" aria-hidden />
      {warnings.length}
      <span className="sr-only">
        {warnings.length === 1 ? " warning: " : " warnings: "}
        {warnings.map((w) => w.label).join(", ")}
      </span>
    </span>
  );
  // Inside a button, a second focus stop would be in the way
  if (plain) return chip;
  return (
    <Tip
      tip={
        <ul className="grid gap-0.5">
          {warnings.map((w, i) => (
            <li key={`${w.kind}-${i}`}>{w.label}</li>
          ))}
        </ul>
      }
    >
      {chip}
    </Tip>
  );
}

export function DocumentStatusCell({ doc: d, plain = false }: { doc: DocumentSummary; plain?: boolean }) {
  if (isReading(d.status)) return <ReadingStatus stage={d.stage} />;
  const s = DOCUMENT_STATUS[d.status] ?? { status: "neutral" as const, label: d.status };
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot status={s.status} label={s.label} showLabel className="whitespace-nowrap" />
      <WarningsChip warnings={d.warnings} plain={plain} />
    </span>
  );
}

/** The steps a document goes through as a row of small segments, lit as each one finishes. */
export function StepSegments({ done, total, active = true, className }: { done: number; total: number; active?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-0.5", className)} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            i < done ? "bg-positive" : i === done && active ? "animate-pulse bg-primary" : "bg-muted",
          )}
        />
      ))}
    </span>
  );
}

/** Documents being read right now, each with its live step. */
export function ReadingNow({ docs, onOpen }: { docs: DocumentSummary[]; onOpen: (id: string) => void }) {
  if (docs.length === 0) return null;
  return (
    <ul aria-label="Being read now" className="grid gap-2">
      {docs.map((d) => {
        const p = stageProgress(d.stage);
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onOpen(d.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 text-left hover:bg-accent/40 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]"
            >
              <span className="truncate text-sm font-medium">{d.counterparty ?? d.filename}</span>
              <span className="text-right text-xs text-muted-foreground tabular sm:order-last">
                {p.index + 1} of {p.total}
              </span>
              <span className="col-span-2 grid gap-1.5 sm:col-span-1">
                <StepSegments done={p.index} total={p.total} />
                <span className="text-xs text-muted-foreground" aria-live="polite">
                  {p.label}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
