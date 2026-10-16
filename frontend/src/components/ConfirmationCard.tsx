import { ArrowRightIcon, CheckIcon, FileTextIcon, InfoIcon, Loader2Icon, UsersIcon, XIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import type { Approval, ApprovalLevel, RecordRef } from "@/api/types";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ApprovalBadge } from "./ApprovalBadge";
import { Button } from "./ui/button";

export type ConfirmationCardProps = {
  title: string;
  level: ApprovalLevel;
  effects: ReactNode[];
  /** Why it needs a person, kept apart from what will change. */
  reasons?: ReactNode[];
  records: RecordRef[];
  whoMustApprove: string;
  /** Defaults to 2 for level 4, otherwise 1. */
  approvalsRequired?: number;
  approvals?: Approval[];
  currentUserId?: string;
  onApprove: () => void;
  onCancel: () => void;
  /** Shown only to people who may decide; a refusal is recorded against the action. */
  onReject?: () => void;
  cancelLabel?: string;
  onEdit?: () => void;
  /** Why the current person can't approve. When set, Approve is disabled and this is shown. */
  approveDisabledReason?: string | null;
  editDisabledReason?: string | null;
  pending?: boolean;
  /** When the surrounding panel already shows the title, keep it for screen readers only. */
  hideTitle?: boolean;
  className?: string;
};

export function ConfirmationCard({
  title,
  level,
  effects,
  reasons = [],
  records,
  whoMustApprove,
  approvalsRequired,
  approvals = [],
  currentUserId,
  onApprove,
  onCancel,
  onReject,
  cancelLabel = "Cancel",
  onEdit,
  approveDisabledReason,
  editDisabledReason,
  pending = false,
  hideTitle = false,
  className,
}: ConfirmationCardProps) {
  const reasonId = useId();
  const editReasonId = useId();
  const required = approvalsRequired ?? (level === 4 ? 2 : 1);
  const alreadyApproved = currentUserId !== undefined && approvals.some((a) => a.user_id === currentUserId);
  const approveReason =
    approveDisabledReason ?? (alreadyApproved ? "You've already approved this. A different person must give the second approval." : null);
  const first = approvals[0];

  return (
    <section aria-label={`Confirm: ${title}`} className={cn("rounded-xl border bg-card shadow-card", className)}>
      {hideTitle ? (
        <h3 className="sr-only">{title}</h3>
      ) : (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
          <h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
          <ApprovalBadge level={level} />
        </header>
      )}

      <div className="grid gap-5 px-5 py-5 text-sm">
        <div>
          <h4 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">What will change</h4>
          <ul className="grid gap-2">
            {effects.map((effect, i) => (
              <li key={i}>
                <Effect effect={effect} />
              </li>
            ))}
          </ul>
        </div>

        {reasons.length > 0 && (
          <div className="grid gap-1.5 rounded-lg bg-muted/60 px-3.5 py-3">
            <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <InfoIcon className="size-3.5" aria-hidden /> Why it needs a person
            </h4>
            <ul className="grid gap-1">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {records.length > 0 && (
          <div>
            <h4 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Affected records</h4>
            <ul className="flex flex-wrap gap-1.5">
              {records.map((r) => (
                <li key={r.id}>
                  {r.href ? (
                    <Link to={r.href} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent">
                      <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                      {r.label}
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                      <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
                      {r.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="flex items-start gap-2">
              <UsersIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="text-muted-foreground">Who must approve: </span>
                {whoMustApprove}
              </span>
            </p>
            <span className="flex items-center gap-3">
              {required > 1 && (
                <span className="flex items-center gap-2" aria-live="polite">
                  <ApprovalProgress done={approvals.length} required={required} />
                  <span className="tabular">
                    {approvals.length} of {required} approvals
                  </span>
                </span>
              )}
              {hideTitle && <ApprovalBadge level={level} />}
            </span>
          </div>
          {required > 1 && first && (
            <p className="flex items-center gap-1.5 pl-6 text-muted-foreground">
              <CheckIcon className="size-3.5 text-positive" aria-hidden />
              First approval by {first.name}, {formatRelative(first.at)}
            </p>
          )}
        </div>
      </div>

      <footer className="grid gap-2 border-t rounded-b-xl bg-muted/30 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onApprove} disabled={Boolean(approveReason) || pending} aria-describedby={approveReason ? reasonId : undefined}>
            {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : <CheckIcon aria-hidden />}
            Approve
          </Button>
          {onEdit && (
            <Button variant="secondary" onClick={onEdit} disabled={Boolean(editDisabledReason) || pending} aria-describedby={editDisabledReason ? editReasonId : undefined}>
              Edit
            </Button>
          )}
          {onReject && (
            <Button variant="secondary" onClick={onReject} disabled={pending}>
              <XIcon aria-hidden /> Reject
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
        </div>
        {approveReason && <DisabledReason id={reasonId}>{approveReason}</DisabledReason>}
        {onEdit && editDisabledReason && <DisabledReason id={editReasonId}>{editDisabledReason}</DisabledReason>}
      </footer>
    </section>
  );
}

// "bank account: ••••6587 → ••••1234" reads better as old, arrow, new
const CHANGE = /^([^:→]+):\s*(.+?)\s*→\s*(.+)$/;

function Effect({ effect }: { effect: ReactNode }) {
  const change = typeof effect === "string" ? CHANGE.exec(effect) : null;
  if (change) {
    const [, label, from, to] = change;
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-28 text-muted-foreground first-letter:uppercase">{label}</span>
        <span className="tabular text-muted-foreground line-through decoration-muted-foreground/50">{from}</span>
        <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-label="changes to" />
        <span className="font-medium tabular">{to}</span>
      </span>
    );
  }
  return (
    <span className="flex gap-2">
      <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
      <span>{effect}</span>
    </span>
  );
}

function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

function ApprovalProgress({ done, required }: { done: number; required: number }) {
  return (
    <span className="flex gap-1" aria-hidden>
      {Array.from({ length: required }, (_, i) => (
        <span key={i} className={cn("h-1.5 w-5 rounded-full", i < done ? "bg-positive" : "bg-muted")} />
      ))}
    </span>
  );
}
