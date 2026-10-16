import { DownloadIcon, FileQuestionIcon } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/api/client";
import { useDocument } from "@/api/hooks";
import type { DocumentStep, ExtractedField } from "@/api/types";
import { cn } from "@/lib/utils";
import { ActionConfirmation } from "./ActionConfirmation";
import { Skeleton } from "./ui/skeleton";
import { EmptyState, ErrorState } from "./states";
import { StatusDot, type Status } from "./StatusDot";

export function confidenceStatus(confidence: number): { status: Status; label: string } {
  if (confidence >= 0.9) return { status: "positive", label: "High confidence" };
  if (confidence >= 0.7) return { status: "warning", label: "Worth a check" };
  return { status: "danger", label: "Low confidence, please check" };
}

/** Original on the left with each found value highlighted; extracted fields on the right. */
export function DocumentReview({ id, onDone }: { id: string; onDone?: () => void }) {
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
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <section aria-label="Original document" className="grid content-start gap-3">
        <DocumentJourney steps={d.steps} />
        {d.pages.map((page, i) => (
          <div key={page.url} className="relative overflow-hidden rounded-lg border bg-white">
            <img src={page.url} width={page.width} height={page.height} alt={`Page ${i + 1} of ${d.filename}`} className="h-auto w-full" />
            {d.fields
              .filter((f) => f.box && f.box.page === i)
              .map((f) => (
                <span
                  key={f.key}
                  aria-hidden
                  className={cn(
                    "absolute rounded-sm ring-2 transition-colors",
                    active === f.key ? "bg-primary/20 ring-primary" : "bg-warning/10 ring-warning/50",
                  )}
                  style={{ left: `${f.box!.x * 100}%`, top: `${f.box!.y * 100}%`, width: `${f.box!.w * 100}%`, height: `${f.box!.h * 100}%` }}
                />
              ))}
          </div>
        ))}
        <a href={d.original_url} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline" download>
          <DownloadIcon className="size-4" aria-hidden /> Download the original
        </a>
      </section>

      <section aria-label="What we found" className="grid content-start gap-4">
        <dl className="divide-y rounded-xl border">
          {d.fields.map((f) => (
            <FieldRow key={f.key} field={f} active={active === f.key} onHover={setActive} />
          ))}
        </dl>
        {d.confirmation && <ActionConfirmation confirmation={d.confirmation} onDone={onDone} />}
      </section>
    </div>
  );
}

function FieldRow({ field, active, onHover }: { field: ExtractedField; active: boolean; onHover: (key: string | null) => void }) {
  const conf = confidenceStatus(field.confidence);
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-3", active && "bg-primary-soft/60")}
      onMouseEnter={() => onHover(field.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(field.key)}
      onBlur={() => onHover(null)}
      tabIndex={field.box ? 0 : undefined}
    >
      <dt className="w-32 shrink-0 text-sm text-muted-foreground">{field.label}</dt>
      <dd className="min-w-0 flex-1 truncate text-sm font-medium tabular">{field.value}</dd>
      <StatusDot status={conf.status} label={conf.label} />
    </div>
  );
}

const stepStatus: Record<DocumentStep["state"], Status> = { pending: "neutral", active: "accent", done: "positive", retry: "warning", failed: "danger" };

/** The steps a document goes through, lit up as each one finishes. */
export function DocumentJourney({ steps }: { steps: DocumentStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Processing steps">
      {steps.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-xs">
          <StatusDot status={stepStatus[s.state]} label={s.state} pulse={s.state === "active"} />
          <span className={s.state === "pending" ? "text-muted-foreground" : undefined}>
            {s.label}
            {s.state === "retry" && " (second try)"}
          </span>
        </li>
      ))}
    </ol>
  );
}
