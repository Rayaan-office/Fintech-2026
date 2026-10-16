import { CheckIcon, InfoIcon, Loader2Icon } from "lucide-react";
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
  records: RecordRef[];
  whoMustApprove: string;
  /** Defaults to 2 for level 4, otherwise 1. */
  approvalsRequired?: number;
  approvals?: Approval[];
  currentUserId?: string;
  onApprove: () => void;
  onCancel: () => void;
  onEdit?: () => void;
  /** Why the current person can't approve. When set, Approve is disabled and this is shown. */
  approveDisabledReason?: string | null;
  editDisabledReason?: string | null;
  pending?: boolean;
  className?: string;
};

export function ConfirmationCard({
  title,
  level,
  effects,
  records,
  whoMustApprove,
  approvalsRequired,
  approvals = [],
  currentUserId,
  onApprove,
  onCancel,
  onEdit,
  approveDisabledReason,
  editDisabledReason,
  pending = false,
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
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
        <ApprovalBadge level={level} />
      </header>

      <div className="grid gap-5 px-5 py-4 text-sm">
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">What will change</h4>
          <ul className="grid gap-1.5">
            {effects.map((effect, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                <span>{effect}</span>
              </li>
            ))}
          </ul>
        </div>

        {records.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Affected records</h4>
            <ul className="flex flex-wrap gap-1.5">
              {records.map((r) => (
                <li key={r.id}>
                  {r.href ? (
                    <Link to={r.href} className="inline-flex rounded-md border px-2 py-1 text-xs hover:bg-accent">
                      {r.label}
                    </Link>
                  ) : (
                    <span className="inline-flex rounded-md border px-2 py-1 text-xs">{r.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            <span className="text-muted-foreground">Who must approve: </span>
            {whoMustApprove}
          </p>
          {required > 1 && (
            <p className="flex items-center gap-2" aria-live="polite">
              <ApprovalProgress done={approvals.length} required={required} />
              <span>
                {approvals.length} of {required} approvals
              </span>
            </p>
          )}
        </div>
        {required > 1 && first && (
          <p className="-mt-3 flex items-center gap-1.5 text-muted-foreground">
            <CheckIcon className="size-3.5 text-positive" aria-hidden />
            First approval by {first.name}, {formatRelative(first.at)}
          </p>
        )}
      </div>

      <footer className="grid gap-2 border-t px-5 py-3">
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
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
        {approveReason && <DisabledReason id={reasonId}>{approveReason}</DisabledReason>}
        {onEdit && editDisabledReason && <DisabledReason id={editReasonId}>{editDisabledReason}</DisabledReason>}
      </footer>
    </section>
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
