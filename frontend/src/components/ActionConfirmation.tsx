import { CheckIcon, CircleSlashIcon, Undo2Icon } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useApproveAction, useCancelAction, useRejectAction, useUndoAction } from "@/api/hooks";
import type { Action, Confirmation, RecordRef } from "@/api/types";
import { ConfirmationCard } from "./ConfirmationCard";
import { useMoneyText } from "./Money";
import { Button } from "./ui/button";

/** Why this person can't approve, in the server's own words, or null if they can. */
export function approveBlockedReason(a: Action): string | null {
  if (a.status !== "pending") return "This has already been decided.";
  return a.can_approve ? null : (a.why_not ?? "Your role does not allow approving this.");
}

function records(a: Action): RecordRef[] {
  return a.document_id ? [{ id: a.document_id, kind: "document", label: "The original document", href: `/documents?open=${a.document_id}` }] : [];
}

/** Toasts after a decision, with Undo for small changes the server says can be reversed. */
export function useDecisionToasts() {
  const undo = useUndoAction();
  const currency = useCurrentUser().business.currency;
  const money = useMoneyText();
  return (a: Action) => {
    if (a.status === "pending") {
      toast.success(`Your approval is in (${a.approvals.length} of ${a.required_approvals}). A different person must approve it too.`);
    } else if (a.status === "executed") {
      const amount = a.amount_minor != null ? ` (${money(a.amount_minor, currency)})` : "";
      toast.success(`Done: ${a.summary}${amount}`, {
        action: a.can_undo
          ? {
              label: "Undo",
              onClick: () =>
                undo.mutate(a.id, {
                  onSuccess: () => toast("Undone. Your records are back as they were."),
                  onError: (err) => toast.error(errorMessage(err)),
                }),
            }
          : undefined,
      });
    } else if (a.status === "rejected") {
      toast("Rejected. Nothing was changed.");
    } else if (a.status === "cancelled") {
      toast("Cancelled. Nothing was changed.");
    }
  };
}

type ActionConfirmationProps = {
  confirmation: Confirmation;
  onDone?: () => void;
  onEdit?: () => void;
  /** The panel around the card already shows its title. */
  hideTitle?: boolean;
  /** Warnings already shown nearby; reasons that repeat them are left out. */
  shownWarnings?: string[];
  /** Shown beside its document, so no link back to it. */
  besideDocument?: boolean;
};

/** A confirmation card wired to the server: approve, reject or cancel, and a short tick when done. */
export function ActionConfirmation({ confirmation, onDone, onEdit, hideTitle, shownWarnings = [], besideDocument }: ActionConfirmationProps) {
  const approve = useApproveAction();
  const reject = useRejectAction();
  const cancel = useCancelAction();
  const announce = useDecisionToasts();
  // The server's latest answer, so "1 of 2 approvals" updates at once
  const [latest, setLatest] = useState<Action | null>(null);
  const a = latest?.id === confirmation.id ? latest : confirmation;

  if (a.status !== "pending") return <Decided action={a} />;

  const decided = (next: Action) => {
    setLatest(next);
    announce(next);
    if (next.status !== "pending") onDone?.();
  };
  const failed = (err: unknown) => toast.error(errorMessage(err));

  return (
    <ConfirmationCard
      title={a.summary}
      level={a.level}
      effects={a.effects}
      reasons={a.reasons.filter((r) => !shownWarnings.some((w) => r.startsWith(w)))}
      hideTitle={hideTitle}
      records={besideDocument ? [] : records(a)}
      whoMustApprove={a.approvers}
      approvalsRequired={a.required_approvals}
      approvals={a.approvals}
      approveDisabledReason={approveBlockedReason(a)}
      pending={approve.isPending || reject.isPending || cancel.isPending}
      onEdit={onEdit}
      onApprove={() => approve.mutate(a.id, { onSuccess: decided, onError: failed })}
      onReject={a.can_approve ? () => reject.mutate(a.id, { onSuccess: decided, onError: failed }) : undefined}
      cancelLabel="Cancel request"
      onCancel={() => cancel.mutate(a.id, { onSuccess: decided, onError: failed })}
    />
  );
}

const DECIDED: Record<Exclude<Action["status"], "pending">, string> = {
  executed: "Approved and done",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Approved, but it couldn't be completed",
  undone: "Undone",
};

function Decided({ action: a }: { action: Action }) {
  const undo = useUndoAction();
  const ok = a.status === "executed";
  // A failure's message, or why the server cancelled a stale suggestion
  const message = a.status === "failed" ? (a.result?.message as string | undefined) : a.status === "cancelled" ? (a.result?.reason as string | undefined) : undefined;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-4 shadow-card" role="status">
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 28 }}
        className={ok ? "flex size-8 items-center justify-center rounded-full bg-positive-soft text-positive" : "flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground"}
      >
        {ok ? <CheckIcon className="size-4" aria-hidden /> : <CircleSlashIcon className="size-4" aria-hidden />}
      </motion.span>
      <span className="grid text-sm">
        <span className="font-medium">{DECIDED[a.status as keyof typeof DECIDED]}</span>
        <span className="text-muted-foreground">{message ?? a.summary}</span>
      </span>
      {a.can_undo && (
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={undo.isPending}
          onClick={() =>
            undo.mutate(a.id, {
              onSuccess: () => toast("Undone. Your records are back as they were."),
              onError: (err) => toast.error(errorMessage(err)),
            })
          }
        >
          <Undo2Icon aria-hidden /> Undo
        </Button>
      )}
    </div>
  );
}
