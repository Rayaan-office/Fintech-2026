import { CheckIcon } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useApproveAction, useCancelAction } from "@/api/hooks";
import type { Confirmation, Me, Permission } from "@/api/types";
import { formatMoney } from "@/lib/money";
import { ConfirmationCard } from "./ConfirmationCard";

/** Why this person can't approve, in plain words, or null if they can. */
export function approveBlockedReason(c: Confirmation, me: Me): string | null {
  if (!me.permissions.includes(c.approve_permission as Permission)) {
    return `Your role can't approve this. ${c.who_must_approve} must approve it.`;
  }
  if (c.amount_minor != null && me.approval_limit_minor != null && c.amount_minor > me.approval_limit_minor) {
    return `This is above your approval limit of ${formatMoney(me.approval_limit_minor, me.business.currency)}. Someone with a higher limit must approve it.`;
  }
  return null;
}

/** A confirmation card wired to the server: approve, cancel, and a short tick when done. */
export function ActionConfirmation({ confirmation, onDone, onEdit }: { confirmation: Confirmation; onDone?: () => void; onEdit?: () => void }) {
  const me = useCurrentUser();
  const approve = useApproveAction();
  const cancel = useCancelAction();
  const [approved, setApproved] = useState(false);

  if (approved) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-4 shadow-card" role="status">
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
          className="flex size-8 items-center justify-center rounded-full bg-positive-soft text-positive"
        >
          <CheckIcon className="size-4" aria-hidden />
        </motion.span>
        <span className="text-sm font-medium">Approved</span>
      </div>
    );
  }

  return (
    <ConfirmationCard
      title={confirmation.title}
      level={confirmation.level}
      effects={confirmation.effects}
      records={confirmation.records}
      whoMustApprove={confirmation.who_must_approve}
      approvalsRequired={confirmation.approvals_required}
      approvals={confirmation.approvals}
      currentUserId={me.user.id}
      approveDisabledReason={approveBlockedReason(confirmation, me)}
      pending={approve.isPending || cancel.isPending}
      onEdit={onEdit}
      onApprove={() =>
        approve.mutate(confirmation.action_id, {
          onSuccess: (res) => {
            setApproved(true);
            toast.success(res.message);
            onDone?.();
          },
          onError: (err) => toast.error(errorMessage(err)),
        })
      }
      onCancel={() =>
        cancel.mutate(confirmation.action_id, {
          onSuccess: () => {
            toast("Cancelled. Nothing was changed.");
            onDone?.();
          },
          onError: (err) => toast.error(errorMessage(err)),
        })
      }
    />
  );
}
