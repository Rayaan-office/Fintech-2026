import {
  BanknoteIcon,
  Building2Icon,
  CalendarClockIcon,
  CalendarIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CoinsIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileQuestionIcon,
  FileTextIcon,
  FolderIcon,
  HashIcon,
  ListChecksIcon,
  Loader2Icon,
  MailIcon,
  PencilLineIcon,
  PercentIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ScanTextIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TagIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useCan } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useCorrectFields, useDocument, useReprocessDocument } from "@/api/hooks";
import type { DocumentDetail, DocumentStatus, Highlight, TimelineStep } from "@/api/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActionConfirmation } from "./ActionConfirmation";
import { WhatTheAiSaw } from "./AiText";
import { Money } from "./Money";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { EmptyState, ErrorState } from "./states";
import { StatusDot, type Status } from "./StatusDot";

export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; status: Status }> = {
  received: { label: "Reading", status: "accent" },
  queued: { label: "Reading", status: "accent" },
  processing: { label: "Reading", status: "accent" },
  review: { label: "Needs a check", status: "warning" },
  awaiting_approval: { label: "Waiting for approval", status: "accent" },
  approved: { label: "Done", status: "positive" },
  rejected: { label: "Rejected", status: "neutral" },
};

export const isReading = (status: DocumentStatus) => status === "received" || status === "queued" || status === "processing";

// The fields a person can correct, in reading order, with plain labels
const FIELDS: { key: string; label: string; icon: LucideIcon; kind?: "money" | "date" | "type" }[] = [
  { key: "counterparty_name", label: "From or to", icon: Building2Icon },
  { key: "doc_type", label: "Type", icon: TagIcon, kind: "type" },
  { key: "reference", label: "Number", icon: HashIcon },
  { key: "issue_date", label: "Date", icon: CalendarIcon, kind: "date" },
  { key: "due_date", label: "Due", icon: CalendarClockIcon, kind: "date" },
  { key: "subtotal", label: "Before VAT", icon: ReceiptIcon, kind: "money" },
  { key: "tax", label: "VAT", icon: PercentIcon, kind: "money" },
  { key: "total", label: "Total", icon: BanknoteIcon, kind: "money" },
  { key: "currency", label: "Currency", icon: CoinsIcon },
  { key: "category_hint", label: "What for", icon: FolderIcon },
];

const DOC_TYPES: Record<string, string> = {
  bill: "Bill to pay",
  invoice: "Invoice we sent",
  receipt: "Receipt",
  payment_notice: "Payment notice",
  credit_note: "Credit note",
  other: "Something else",
};

const fieldText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** "1,234.50" or "£1234.5" → pence, or null when it isn't an amount. */
export function toMinor(value: string): number | null {
  const clean = value.replace(/[£$€,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Original on the left with each found value highlighted; what we read on the right. */
export function DocumentReview({ id, onDone, actionId }: { id: string; onDone?: () => void; actionId?: string }) {
  const doc = useDocument(id);
  const [active, setActive] = useState<string | null>(null);

  if (doc.isPending) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]" aria-busy="true">
        <Skeleton className="aspect-[1/1.3] w-full" />
        <div className="grid content-start gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (doc.isError) return <ErrorState message={errorMessage(doc.error)} onRetry={() => void doc.refetch()} />;
  if (!doc.data) return <EmptyState icon={FileQuestionIcon} title="We couldn't find this document" description="It may have been removed or you may not have access to it." />;

  const d = doc.data;
  const pending = d.actions.filter((a) => a.status === "pending");
  // Opened to decide one action: its card comes first and the panel already shows its title
  const focused = actionId ? d.actions.find((a) => a.id === actionId) : undefined;
  const others = pending.filter((a) => a.id !== focused?.id);
  const shownWarnings = d.warnings.map((w) => w.label);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Warnings doc={d} />
      {focused && <ActionConfirmation confirmation={focused} onDone={onDone} hideTitle shownWarnings={shownWarnings} besideDocument />}
      {focused ? (
        others.length > 0 && <AlsoWaiting actions={others} onDone={onDone} shownWarnings={shownWarnings} />
      ) : (
        others.map((a) => <ActionConfirmation key={a.id} confirmation={a} onDone={onDone} shownWarnings={shownWarnings} besideDocument />)
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
        <section aria-label="Original document" className="grid min-w-0 gap-4 lg:sticky lg:top-0">
          <Original doc={d} active={active} />
          <DocumentJourney timeline={d.timeline} status={d.status} />
        </section>

        <section aria-label="What we found" className="grid min-w-0 gap-4">
          <Fields doc={d} active={active} onActive={setActive}>
            <SenderChecks doc={d} />
          </Fields>
          {d.ai_saw && (
            <WhatTheAiSaw redactedInput={d.ai_saw} variant="card">
              {d.attempts.length > 0 && (
                <ul className="grid gap-1 border-t pt-2 text-xs text-muted-foreground">
                  {d.attempts.map((a) => (
                    <li key={`${a.attempt}-${a.role}`}>
                      {a.role === "second_opinion" ? "Second opinion" : a.role === "retry" ? "Second try" : "First reading"}: {a.passed ? "the numbers added up" : a.problems.join(" ") || "didn't pass the checks"}
                    </li>
                  ))}
                </ul>
              )}
            </WhatTheAiSaw>
          )}
        </section>
      </div>
    </div>
  );
}

/** Other approvals on the same document, folded away so the one being decided stays the focus. */
function AlsoWaiting({ actions, onDone, shownWarnings }: { actions: DocumentDetail["actions"]; onDone?: () => void; shownWarnings: string[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="grid grid-cols-1 gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-left text-sm hover:bg-accent/60"
      >
        <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Also waiting on this document</span>
          <span className="block truncate text-muted-foreground">{actions.length === 1 ? actions[0]!.summary : `${actions.length} more approvals`}</span>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="grid gap-4">
          {actions.map((a) => (
            <ActionConfirmation key={a.id} confirmation={a} onDone={onDone} shownWarnings={shownWarnings} besideDocument />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pages are shown as images: our security policy blocks PDFs inside the page. Photos are shown
 * as they are; PDF pages come from the page-image address and fall back to a link to the original.
 */
function Original({ doc: d, active }: { doc: DocumentDetail; active: string | null }) {
  const base = `/api/documents/${encodeURIComponent(d.id)}`;
  const isImage = /^image\/(jpeg|png|webp)$/.test(d.mime);
  const isPdf = d.mime === "application/pdf";
  const [failed, setFailed] = useState(false);
  const pages = isImage ? [`${base}/original`] : isPdf && !failed ? Array.from({ length: d.pages ?? 1 }, (_, i) => `${base}/pages/${i}`) : [];

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex items-center gap-2 border-b py-2 pr-2 pl-4">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={d.filename}>
          {d.filename}
        </span>
        {d.pages != null && d.pages > 1 && <span className="shrink-0 text-xs text-muted-foreground tabular">{d.pages} pages</span>}
        <Button asChild variant="ghost" size="icon-sm" title="Open the original in a new tab">
          <a href={`${base}/original`} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon aria-hidden />
            <span className="sr-only">Open the original</span>
          </a>
        </Button>
        <Button asChild variant="ghost" size="icon-sm" title="Download">
          <a href={`${base}/original`} download={d.filename}>
            <DownloadIcon aria-hidden />
            <span className="sr-only">Download</span>
          </a>
        </Button>
      </div>
      {pages.length > 0 ? (
        <div className="grid gap-3 bg-muted/40 p-3">
          {pages.map((src, i) => (
            <div key={src} className="relative overflow-hidden rounded-md border bg-white shadow-sm">
              <img src={src} alt={`Page ${i + 1} of ${d.filename}`} className="h-auto w-full" onError={() => setFailed(true)} />
              {d.highlights
                .filter((h) => h.page === i)
                .map((h, j) => (
                  <HighlightBox key={`${h.field}-${j}`} h={h} active={active === h.field} />
                ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 bg-muted/30 px-6 py-12 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-card shadow-card">
            <FileTextIcon className="size-5 text-muted-foreground" aria-hidden />
          </span>
          <p className="max-w-xs text-sm text-muted-foreground">
            {isPdf ? "A picture of each page isn't available yet. Open the original to see it." : "This kind of file has no preview. Open the original to see it."}
          </p>
          <Button asChild variant="secondary" size="sm">
            <a href={`${base}/original`} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon aria-hidden /> Open in a new tab
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

function HighlightBox({ h, active }: { h: Highlight; active: boolean }) {
  const [x0, y0, x1, y1] = h.box;
  // A little padding so the ring doesn't sit on the text
  return (
    <span
      aria-hidden
      data-field={h.field}
      className={cn("absolute rounded-sm ring-2 transition-colors", active ? "bg-primary/20 ring-primary" : "bg-warning/10 ring-warning/50")}
      style={{ left: `calc(${x0 * 100}% - 2px)`, top: `calc(${y0 * 100}% - 2px)`, width: `calc(${(x1 - x0) * 100}% + 4px)`, height: `calc(${(y1 - y0) * 100}% + 4px)` }}
    />
  );
}

function Warnings({ doc: d }: { doc: DocumentDetail }) {
  const reasons = d.status === "review" ? d.review_reasons : [];
  if (d.warnings.length === 0 && reasons.length === 0) return null;
  return (
    <div className="grid gap-3">
      {d.warnings.length > 0 && (
        <section role="alert" aria-label="Warnings" className="overflow-hidden rounded-xl border border-danger/30 bg-danger-soft/40">
          <h3 className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-sm font-semibold text-danger">
            <ShieldAlertIcon className="size-4 shrink-0" aria-hidden />
            {d.warnings.length === 1 ? "Check this before you approve" : `${d.warnings.length} things to check before you approve`}
          </h3>
          <ul className="grid gap-2.5 px-4 pb-3.5 pl-10 text-sm">
            {d.warnings.map((w, i) => (
              <li key={`${w.kind}-${i}`}>
                <p className="font-medium">{w.label}</p>
                <p className="text-muted-foreground">{w.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reasons.length > 0 && (
        <section aria-label="Why this needs a person" className="rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-3.5 text-sm">
          <h3 className="flex items-center gap-2 font-semibold">
            <TriangleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
            Why this needs a person
          </h3>
          <ul className="mt-1.5 grid gap-1 pl-6 text-muted-foreground">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Fields({ doc: d, active, onActive, children }: { doc: DocumentDetail; active: string | null; onActive: (key: string | null) => void; children?: ReactNode }) {
  const can = useCan();
  const correct = useCorrectFields(d.id);
  const reprocess = useReprocessDocument(d.id);
  const [editing, setEditing] = useState(false);
  const decided = d.status === "approved" || d.status === "rejected";
  const mayEdit = can("review_documents") && !decided && !isReading(d.status);
  const found = new Set(d.highlights.map((h) => h.field));
  const hasFields = Object.keys(d.fields ?? {}).length > 0;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const changed: Record<string, string> = {};
    for (const f of FIELDS) {
      const value = String(form.get(f.key) ?? "").trim();
      if (value !== fieldText(d.fields[f.key]).trim()) changed[f.key] = value;
    }
    // Saving with nothing changed still counts as "a person checked it" while it waits for review
    if (Object.keys(changed).length === 0 && d.status !== "review") return setEditing(false);
    correct.mutate(changed, {
      onSuccess: (next) => {
        setEditing(false);
        toast.success(next.status === "awaiting_approval" && d.status === "review" ? "Saved. It now waits for approval." : "Corrections saved. The AI's first answer is kept beside them.");
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  if (isReading(d.status) && !hasFields) {
    return (
      <p className="flex flex-col items-center gap-2 rounded-xl border px-4 py-10 text-center text-sm text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin" aria-hidden />
        We're still reading this document. What we find will appear here.
      </p>
    );
  }

  if (editing) {
    return (
      <form onSubmit={save} className="grid gap-3 rounded-xl border bg-card p-5 shadow-card" aria-label="Correct what we read">
        {FIELDS.map((f) => (
          <label key={f.key} className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{f.label}</span>
            {f.kind === "type" ? (
              <select name={f.key} defaultValue={fieldText(d.fields[f.key]) || "bill"} className="h-9 rounded-md border bg-transparent px-2 text-sm">
                {Object.entries(DOC_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                name={f.key}
                defaultValue={fieldText(d.fields[f.key])}
                inputMode={f.kind === "money" ? "decimal" : undefined}
                placeholder={f.kind === "money" ? "120.50" : f.kind === "date" ? "2026-10-30" : undefined}
                className="h-9"
              />
            )}
          </label>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" disabled={correct.isPending}>
            {correct.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
            {d.status === "review" ? "Save and send for approval" : "Save corrections"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={correct.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b py-2 pr-2 pl-4">
        <h3 className="flex flex-1 items-center gap-2 text-sm font-semibold">
          <ScanTextIcon className="size-4 text-muted-foreground" aria-hidden /> What we read
        </h3>
        {mayEdit && (
          <div className="flex gap-1">
            {d.status === "review" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={reprocess.isPending}
                onClick={() =>
                  reprocess.mutate(undefined, {
                    onSuccess: () => toast("Reading it again. This takes a few seconds."),
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              >
                <RotateCcwIcon aria-hidden /> Read it again
              </Button>
            )}
            <Button variant={d.status === "review" ? "default" : "secondary"} size="sm" onClick={() => setEditing(true)}>
              <PencilLineIcon aria-hidden /> {d.status === "review" ? "Check and correct" : "Correct"}
            </Button>
          </div>
        )}
      </div>
      <dl className="divide-y">
        {FIELDS.map((f) => {
          const value = fieldText(d.fields?.[f.key]);
          const minor = f.kind === "money" ? toMinor(value) : null;
          const Icon = f.icon;
          return (
            <div
              key={f.key}
              className={cn("flex items-center gap-3 px-4 py-2.5 transition-colors", f.key === "total" && "bg-muted/40", active === f.key && "bg-primary-soft/60")}
              onMouseEnter={() => onActive(f.key)}
              onMouseLeave={() => onActive(null)}
              onFocus={() => onActive(f.key)}
              onBlur={() => onActive(null)}
              tabIndex={found.has(f.key) ? 0 : undefined}
            >
              <dt className="flex w-32 shrink-0 items-center gap-2 text-sm text-muted-foreground">
                <Icon className="size-3.5 shrink-0" aria-hidden />
                {f.label}
              </dt>
              <dd className={cn("min-w-0 flex-1 truncate text-sm font-medium tabular", f.key === "total" && "text-base font-semibold")}>
                {!value ? (
                  <span className="font-normal text-muted-foreground">Not found</span>
                ) : minor !== null ? (
                  <Money minor={minor} currency={fieldText(d.fields.currency) || d.currency} />
                ) : f.kind === "type" ? (
                  (DOC_TYPES[value] ?? value)
                ) : f.kind === "date" ? (
                  <time dateTime={value}>{formatDate(value, true)}</time>
                ) : (
                  value
                )}
              </dd>
              {found.has(f.key) && <span className="sr-only">Highlighted on the original</span>}
            </div>
          );
        })}
      </dl>
      {children}
    </div>
  );
}

function SenderChecks({ doc: d }: { doc: DocumentDetail }) {
  const checks = Object.entries(d.sender_checks ?? {}).filter(([k]) => ["spf", "dkim", "dmarc"].includes(k));
  if (d.source !== "email" || (!d.sender_domain && checks.length === 0)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
      <MailIcon className="size-3.5" aria-hidden />
      <span className="mr-1">Sent from {d.sender_domain ?? "an unknown address"}</span>
      {checks.map(([name, result]) => {
        const ok = String(result).toLowerCase() === "pass";
        return (
          <Badge key={name} variant={ok ? "positive" : "danger"} title={ok ? "This standard sender check passed." : "This standard sender check did not pass."}>
            {ok ? <ShieldCheckIcon aria-hidden /> : <ShieldAlertIcon aria-hidden />}
            {name.toUpperCase()} {ok ? "passed" : String(result)}
          </Badge>
        );
      })}
    </div>
  );
}

// The steps every document goes through, in order. A second try and second opinion appear only when they happen.
const JOURNEY = ["received", "safety_check", "archived", "reading", "hiding_details", "privacy_check", "ai_form", "checks", "retry", "second_opinion", "matching", "done"];
const OPTIONAL = new Set(["retry", "second_opinion"]);
const SHORT: Record<string, string> = {
  received: "Received",
  safety_check: "Safety check",
  archived: "Locked away",
  reading: "Reading",
  hiding_details: "Hiding personal details",
  privacy_check: "Privacy check",
  ai_form: "AI fills the form",
  checks: "Numbers add up",
  retry: "Second try",
  second_opinion: "Second opinion",
  matching: "Matching",
  done: "Done",
};

type StepState = "pending" | "active" | "done" | "retry" | "failed";
const stepStatus: Record<StepState, Status> = { pending: "neutral", active: "accent", done: "positive", retry: "warning", failed: "danger" };
const stepWords: Record<StepState, string> = { pending: "not yet", active: "working on it", done: "done", retry: "tried again", failed: "stopped here" };

/** Each step's state from the timeline: its last entry decides, and the first missing step is the one in progress. */
export function journeySteps(timeline: TimelineStep[], status: DocumentStatus): { key: string; label: string; state: StepState; note?: string | null }[] {
  const last = new Map<string, TimelineStep>();
  for (const t of timeline) last.set(t.stage, t);
  const reading = isReading(status);
  let activeGiven = false;
  return JOURNEY.filter((k) => !OPTIONAL.has(k) || last.has(k)).map((key) => {
    const t = last.get(key);
    let state: StepState;
    if (t) state = t.ok ? "done" : key === "checks" && last.has("retry") ? "retry" : "failed";
    else if (reading && !activeGiven) {
      state = "active";
      activeGiven = true;
    } else state = "pending";
    return { key, label: SHORT[key] ?? t?.label ?? key, state, note: t?.note };
  });
}

/** The steps a document goes through, lit up live as each one finishes. Folds to one line once all went well. */
export function DocumentJourney({ timeline, status }: { timeline: TimelineStep[]; status: DocumentStatus }) {
  const steps = journeySteps(timeline, status);
  const allDone = steps.every((s) => s.state === "done");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const list = (
    <ol id={panelId} className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3" aria-label="Processing steps">
      {steps.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5 text-xs" title={s.note ?? undefined}>
          <StatusDot status={stepStatus[s.state]} label={stepWords[s.state]} pulse={s.state === "active"} />
          <span className={cn("truncate", s.state === "pending" && "text-muted-foreground")}>{s.label}</span>
        </li>
      ))}
    </ol>
  );

  if (!allDone) {
    return (
      <div className="grid gap-3 rounded-xl border px-4 py-3.5">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ListChecksIcon className="size-4 text-muted-foreground" aria-hidden /> How we read it
        </h3>
        {list}
      </div>
    );
  }
  return (
    <div className="rounded-xl border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm hover:bg-accent/60"
      >
        <CircleCheckIcon className="size-4 shrink-0 text-positive" aria-hidden />
        <span className="flex-1">Read and checked in {steps.length} steps</span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && <div className="border-t px-4 py-3.5">{list}</div>}
    </div>
  );
}

/** One line for lists: the step a document is on right now. */
export function ReadingStatus({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm" aria-live="polite">
      <StatusDot status="accent" label="Reading:" pulse />
      {SHORT[stage] ?? "Reading"}
    </span>
  );
}
