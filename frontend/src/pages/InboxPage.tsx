import { CheckCheckIcon, FileSearchIcon, InboxIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useApproveAction, useInbox, useUndoAction } from "@/api/hooks";
import type { Action, Inbox, InboxItem, InboxTab } from "@/api/types";
import { ActionConfirmation, approveBlockedReason, useDecisionToasts } from "@/components/ActionConfirmation";
import { ApprovalBadge } from "@/components/ApprovalBadge";
import { DocumentReview } from "@/components/DocumentReview";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/api/auth";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const TABS: { id: InboxTab; label: string; empty: string }[] = [
  { id: "to_review", label: "To review", empty: "Nothing to check. Documents we couldn't finish on our own will appear here." },
  { id: "needs_approval", label: "Needs approval", empty: "Nothing waiting for approval." },
  { id: "done", label: "Done", empty: "Items you've handled will be listed here." },
];

const DONE_LABEL: Record<Action["status"], string> = {
  pending: "Waiting",
  executed: "Done",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Couldn't be completed",
  undone: "Undone",
};

const isDocument = (i: InboxItem) => i.kind === "document";

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  // A notification links to /inbox?action=<id>: open that one on the approvals tab
  const linked = params.get("action");
  const [chosen, setTab] = useState<InboxTab | null>(linked ? "needs_approval" : null);
  // Until the person picks a tab: approvals first, unless only documents are waiting
  const first = useInbox("needs_approval");
  const firstCounts = first.data?.counts;
  const tab: InboxTab = chosen ?? (firstCounts && firstCounts.needs_approval === 0 && firstCounts.to_review > 0 ? "to_review" : "needs_approval");
  const inbox = useInbox(tab);
  const counts = inbox.data?.counts ?? firstCounts;

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader title="Inbox" description="Everything waiting for a person, with the reason it needs one." />
      <Tabs value={tab} onValueChange={(v) => setTab(v as InboxTab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {t.id !== "done" && counts && counts[t.id] > 0 && <span className="text-xs text-muted-foreground tabular">{counts[t.id]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <QueryView
        query={inbox}
        loading={<ListSkeleton rows={6} />}
        empty={<EmptyState icon={InboxIcon} title="Your inbox is empty" description="When a document needs checking or an action needs approval, it will appear here." />}
      >
        {(data) => (
          <InboxList
            key={tab}
            tab={tab}
            data={data}
            linkedId={linked}
            onLinkedHandled={() =>
              setParams(
                (p) => {
                  p.delete("action");
                  return p;
                },
                { replace: true },
              )
            }
          />
        )}
      </QueryView>
    </div>
  );
}

function InboxList({ tab, data, linkedId, onLinkedHandled }: { tab: InboxTab; data: Inbox; linkedId: string | null; onLinkedHandled: () => void }) {
  const approve = useApproveAction();
  const announce = useDecisionToasts();
  const items = data.items;
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | null>(() => (linkedId && items.some((i) => i.id === linkedId) ? linkedId : null));
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const current = items[Math.min(cursor, items.length - 1)];
  const open = items.find((i) => i.id === openId) ?? null;
  // Quick approval (without opening the card) only for one-person changes this person may approve
  const canQuickApprove = (i: InboxItem): i is Action => !isDocument(i) && i.status === "pending" && i.can_approve && i.required_approvals === 1;

  const close = () => {
    setOpenId(null);
    if (linkedId) onLinkedHandled();
  };

  const keys = { enabled: openId === null };
  useHotkeys("j", () => setCursor((c) => Math.min(c + 1, items.length - 1)), keys, [items.length]);
  useHotkeys("k", () => setCursor((c) => Math.max(c - 1, 0)), keys);
  useHotkeys("enter", () => current && setOpenId(current.id), keys, [current]);
  useHotkeys("e", () => current && setOpenId(current.id), keys, [current]);
  useHotkeys("x", () => current && canQuickApprove(current) && toggle(current.id), keys, [current]);
  useHotkeys(
    "a",
    () => {
      if (!current) return;
      if (isDocument(current) || current.status !== "pending") return setOpenId(current.id);
      const blocked = approveBlockedReason(current);
      if (blocked) return toast(blocked);
      // Level 3 and 4 always open the card so the person sees exactly what will happen
      if (current.level >= 3) return setOpenId(current.id);
      approve.mutate(current.id, { onSuccess: announce, onError: (err) => toast.error(errorMessage(err)) });
    },
    keys,
    [current],
  );

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approveSelected() {
    const chosen = items.filter((i): i is Action => selected.has(i.id) && canQuickApprove(i));
    let ok = 0;
    for (const item of chosen) {
      try {
        await approve.mutateAsync(item.id);
        ok += 1;
      } catch (err) {
        toast.error(`${item.summary}: ${errorMessage(err)}`);
      }
    }
    setSelected(new Set());
    if (ok > 0) toast.success(`Approved ${ok} ${ok === 1 ? "item" : "items"}.`);
  }

  const selectedCount = items.filter((i) => selected.has(i.id)).length;
  const label = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <div className={cn("flex-wrap items-center justify-between gap-3", selectedCount > 0 ? "flex" : items.length > 0 ? "hidden lg:flex" : "hidden")}>
        {selectedCount > 0 && (
          <Button onClick={() => void approveSelected()} disabled={approve.isPending}>
            <CheckCheckIcon aria-hidden /> Approve {selectedCount} selected
          </Button>
        )}
        {items.length > 0 && (
          <p className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> to move, <Kbd>A</Kbd> approve, <Kbd>E</Kbd> open
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState icon={InboxIcon} title="All clear" description={label.empty} />
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" aria-label={label.label}>
          <AnimatePresence initial={false}>
            {items.map((item, i) => (
              <motion.li
                key={item.id}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.2 }}
                className={cn("flex items-center gap-3 px-4 py-3.5", i === cursor && "bg-accent/70")}
                aria-current={i === cursor ? "true" : undefined}
              >
                {tab === "needs_approval" &&
                  (canQuickApprove(item) ? (
                    <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} aria-label={`Select: ${item.summary}`} />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  ))}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setCursor(i);
                    setOpenId(item.id);
                  }}
                >
                  <span className="block text-sm font-medium">{item.summary}</span>
                  <ItemLine item={item} />
                </button>
                <ItemSide item={item} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <FocusedPanel open={open !== null} onOpenChange={(o) => !o && close()} title={open?.summary ?? ""} description={open ? describe(open) : undefined}>
        {open &&
          (isDocument(open) ? (
            <DocumentReview id={open.id} onDone={close} />
          ) : open.document_id ? (
            <DocumentReview id={open.document_id} actionId={open.id} onDone={close} />
          ) : (
            <div className="mx-auto max-w-xl">
              <ActionConfirmation confirmation={open} onDone={close} />
            </div>
          ))}
      </FocusedPanel>
    </>
  );
}

function describe(item: InboxItem): string {
  if (isDocument(item)) return item.reasons[0] ?? "We couldn't finish this one on our own.";
  return `${item.type_label}, ${item.requested_by}`;
}

/** The reason it needs a person, who asked, and when. */
function ItemLine({ item }: { item: InboxItem }) {
  if (isDocument(item)) {
    return (
      <span className="block truncate text-xs text-muted-foreground">
        {item.warnings.length > 0 ? item.warnings.map((w) => w.label).join(", ") : (item.reasons[0] ?? "Needs a check")} · {formatRelative(item.created_at)}
      </span>
    );
  }
  const when = item.decided_at ?? item.created_at;
  return (
    <span className="block truncate text-xs text-muted-foreground">
      {item.status === "pending" ? (item.reasons[0] ?? item.type_label) : DONE_LABEL[item.status]}
      {typeof item.result?.reason === "string" && `: ${item.result.reason}`} · {item.requested_by} · {formatRelative(when)}
    </span>
  );
}

function ItemSide({ item }: { item: InboxItem }) {
  const currency = useCurrentUser().business.currency;
  if (isDocument(item)) {
    return item.warnings.length > 0 ? (
      <Badge variant="danger" className="shrink-0">
        <TriangleAlertIcon aria-hidden /> {item.warnings.length === 1 ? "Warning" : `${item.warnings.length} warnings`}
      </Badge>
    ) : (
      <Badge variant="outline" className="shrink-0 max-sm:hidden">
        <FileSearchIcon aria-hidden /> Check
      </Badge>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-3">
      {item.amount_minor != null && <Money minor={item.amount_minor} currency={currency} className="text-sm max-sm:hidden" />}
      {item.status === "pending" && item.required_approvals > 1 && (
        <span className="text-xs text-muted-foreground tabular">
          {item.approvals.length} of {item.required_approvals} approvals
        </span>
      )}
      {item.can_undo ? <UndoButton action={item} /> : <ApprovalBadge level={item.level} className="max-sm:hidden" />}
    </span>
  );
}

function UndoButton({ action }: { action: Action }) {
  const undo = useUndoAction();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={undo.isPending}
      aria-label={`Undo: ${action.summary}`}
      onClick={() =>
        undo.mutate(action.id, {
          onSuccess: () => toast("Undone. Your records are back as they were."),
          onError: (err) => toast.error(errorMessage(err)),
        })
      }
    >
      <Undo2Icon aria-hidden /> Undo
    </Button>
  );
}
