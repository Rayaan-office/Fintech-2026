import {
  BanknoteIcon,
  CheckCheckIcon,
  CircleDotIcon,
  FileSearchIcon,
  InboxIcon,
  LandmarkIcon,
  LinkIcon,
  MailIcon,
  ReceiptIcon,
  TriangleAlertIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useApproveAction, useInbox, useUndoAction } from "@/api/hooks";
import type { Action, Inbox, InboxItem, InboxTab } from "@/api/types";
import { ActionConfirmation, approveBlockedReason, useDecisionToasts } from "@/components/ActionConfirmation";
import { DocumentReview } from "@/components/DocumentReview";
import { IconTile } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const TABS: { id: InboxTab; label: string; empty: string }[] = [
  { id: "to_review", label: "To review", empty: "Documents we couldn't finish on our own will appear here." },
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

const DONE_DOT: Record<Action["status"], string> = {
  pending: "bg-warning",
  executed: "bg-positive",
  rejected: "bg-danger",
  cancelled: "bg-muted-foreground/50",
  failed: "bg-danger",
  undone: "bg-muted-foreground/50",
};

/** The fraud checks' own labels, which start a reason such as "Changed bank details: ...". */
const WARNINGS = ["Changed bank details", "Bank details changed", "Duplicate invoice", "Look-alike sender", "Failed sender checks", "Unusual amount", "Pressure tactics"];

/** Rows shown before "Show all": the inbox opens on a short queue. */
const FIRST_ROWS = 5;

const isDocument = (i: InboxItem) => i.kind === "document";

function warningsOf(item: InboxItem): string[] {
  if (isDocument(item)) return item.warnings.map((w) => w.label);
  if (item.status !== "pending") return [];
  return item.reasons.flatMap((r) => WARNINGS.filter((w) => r.startsWith(`${w}:`)));
}

function iconFor(item: InboxItem): LucideIcon {
  if (isDocument(item)) return FileSearchIcon;
  const t = item.type;
  if (/bank_charge/.test(t)) return ReceiptIcon;
  if (/bank/.test(t)) return LandmarkIcon;
  if (/email|reminder/.test(t)) return MailIcon;
  if (/match/.test(t)) return LinkIcon;
  if (/payment|financ/.test(t)) return BanknoteIcon;
  if (/document|bill/.test(t)) return ReceiptIcon;
  return CircleDotIcon;
}

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  // A notification or search result links to /inbox?action=<id>: open that one on the approvals tab
  const linked = params.get("action");
  const [chosen, setTab] = useState<InboxTab | null>(linked ? "needs_approval" : null);
  // Until the person picks a tab: approvals first, unless only documents are waiting
  const first = useInbox("needs_approval");
  const firstCounts = first.data?.counts;
  const tab: InboxTab = chosen ?? (firstCounts && firstCounts.needs_approval === 0 && firstCounts.to_review > 0 ? "to_review" : "needs_approval");
  const inbox = useInbox(tab);
  const counts = inbox.data?.counts ?? firstCounts;

  return (
    <div className="grid grid-cols-1 gap-8">
      <PageHeader title="Inbox" />
      <InboxTabs tab={tab} counts={counts} onChange={setTab} />
      <QueryView
        query={inbox}
        loading={<ListSkeleton rows={5} />}
        empty={<EmptyState icon={InboxIcon} title="Your inbox is empty" description="Documents to check and changes to approve will appear here." />}
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

function InboxTabs({ tab, counts, onChange }: { tab: InboxTab; counts: Inbox["counts"] | undefined; onChange: (t: InboxTab) => void }) {
  return (
    <Tabs value={tab} onValueChange={(v) => onChange(v as InboxTab)}>
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
            {t.id !== "done" && counts && counts[t.id] > 0 && <span className="text-xs text-muted-foreground tabular">{counts[t.id]}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function InboxList({ tab, data, linkedId, onLinkedHandled }: { tab: InboxTab; data: Inbox; linkedId: string | null; onLinkedHandled: () => void }) {
  const approve = useApproveAction();
  const announce = useDecisionToasts();
  const reduce = useReducedMotion();
  const items = data.items;
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | null>(() => (linkedId && items.some((i) => i.id === linkedId) ? linkedId : null));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);

  const current = items[Math.min(cursor, items.length - 1)];
  const open = items.find((i) => i.id === openId) ?? null;
  // Quick approval (without opening the card) only for one-person changes this person may approve
  // and never for anything carrying a fraud warning: those always open, so the warning is read first
  const canQuickApprove = (i: InboxItem): i is Action => !isDocument(i) && i.status === "pending" && i.can_approve && i.required_approvals === 1 && warningsOf(i).length === 0;
  const anySelectable = tab === "needs_approval" && items.some(canQuickApprove);

  // The short queue grows when the keyboard (or a link) reaches past it
  const openIndex = items.findIndex((i) => i.id === openId);
  const expanded = all || cursor >= FIRST_ROWS || openIndex >= FIRST_ROWS;
  const visible = expanded ? items : items.slice(0, FIRST_ROWS);

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
      // Level 3 and 4, and anything with a warning, always open the card so the person sees exactly what will happen
      if (current.level >= 3 || warningsOf(current).length > 0) return setOpenId(current.id);
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
      <AnimatePresence>
        {selectedCount > 0 && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 12 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 md:bottom-6"
          >
            <div className="flex items-center gap-3 rounded-full border bg-card py-1.5 pr-1.5 pl-4 text-sm shadow-panel">
              <span className="tabular text-muted-foreground">{selectedCount} selected</span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" onClick={() => void approveSelected()} disabled={approve.isPending}>
                <CheckCheckIcon aria-hidden /> Approve {selectedCount} selected
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {items.length === 0 ? (
        <EmptyState icon={InboxIcon} title="All clear" description={label.empty} />
      ) : (
        <div className="grid gap-2">
          <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label={label.label}>
            <AnimatePresence initial={false}>
              {visible.map((item, i) => (
                <motion.li
                  key={item.id}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={reduce ? undefined : { opacity: 0, x: 24 }}
                  transition={{ duration: 0.18 }}
                  className={cn("flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50", i === cursor && "bg-accent/70")}
                  aria-current={i === cursor ? "true" : undefined}
                >
                  {anySelectable &&
                    (canQuickApprove(item) ? (
                      <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} aria-label={`Select: ${item.summary}`} />
                    ) : (
                      <span className="size-4 shrink-0" aria-hidden />
                    ))}
                  <ItemButton
                    item={item}
                    onOpen={() => {
                      setCursor(i);
                      setOpenId(item.id);
                    }}
                  />
                  <ItemSide item={item} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {items.length > FIRST_ROWS && (
            <button type="button" className="justify-self-start text-sm font-medium text-primary hover:underline" aria-expanded={expanded} onClick={() => setAll(!expanded)}>
              {expanded ? "Show fewer" : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}

      <FocusedPanel open={open !== null} onOpenChange={(o) => !o && close()} title={open?.summary ?? ""} description={open ? describe(open) : undefined}>
        {open &&
          (isDocument(open) ? (
            <DocumentReview id={open.id} onDone={close} />
          ) : open.document_id ? (
            <DocumentReview id={open.document_id} actionId={open.id} onDone={close} />
          ) : (
            <div className="mx-auto max-w-xl">
              <ActionConfirmation confirmation={open} onDone={close} hideTitle />
            </div>
          ))}
      </FocusedPanel>
    </>
  );
}

function describe(item: InboxItem): string {
  if (isDocument(item)) return item.reasons[0] ?? "We couldn't finish this one on our own.";
  return `${item.type_label}, ${item.requested_by}, ${formatRelative(item.decided_at ?? item.created_at)}`;
}

/** The row itself: what it is, and only the warnings worth seeing at a glance. The full reasons show on hover and in the card. */
function ItemButton({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const warnings = warningsOf(item);
  const reasons = isDocument(item) ? item.reasons : item.status === "pending" ? item.reasons : [];
  return (
    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen} title={reasons.join("\n") || undefined}>
      <IconTile icon={iconFor(item)} tone={warnings.length > 0 ? "danger" : "neutral"} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium max-sm:line-clamp-2 sm:truncate">{item.summary}</span>
        <ItemLine item={item} warnings={warnings} />
      </span>
    </button>
  );
}

/** One quiet line under the title, only when there is something to flag: a warning, a check to make, or how it ended. */
function ItemLine({ item, warnings }: { item: InboxItem; warnings: string[] }) {
  if (warnings.length > 0) {
    return (
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-medium text-danger">
        {warnings.map((w) => (
          <span key={w} className="inline-flex items-center gap-1">
            <TriangleAlertIcon className="size-3" aria-hidden />
            {w}
          </span>
        ))}
      </span>
    );
  }
  if (isDocument(item)) return <span className="mt-0.5 block text-xs text-muted-foreground">Needs a check</span>;
  if (item.status === "pending") return null;
  const reason = typeof item.result?.reason === "string" ? item.result.reason : null;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", DONE_DOT[item.status])} aria-hidden />
      <span className="truncate">
        {DONE_LABEL[item.status]}
        {reason && `: ${reason}`}
      </span>
      <span className="shrink-0">{formatRelative(item.decided_at ?? item.created_at)}</span>
    </span>
  );
}

/** Two-person progress as two marks and "1/2". */
function ApprovalProgress({ done, required }: { done: number; required: number }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`${done} of ${required} approvals`}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: required }, (_, i) => (
          <span key={i} className={cn("h-1.5 w-3 rounded-full", i < done ? "bg-positive" : "bg-muted-foreground/25")} />
        ))}
      </span>
      <span className="sr-only">
        {done} of {required} approvals
      </span>
      <span className="tabular" aria-hidden>
        {done}/{required}
      </span>
    </span>
  );
}

function ItemSide({ item }: { item: InboxItem }) {
  const currency = useCurrentUser().business.currency;
  if (isDocument(item)) return null;
  return (
    <span className="flex shrink-0 items-center gap-4">
      {item.status === "pending" && item.required_approvals > 1 && <ApprovalProgress done={item.approvals.length} required={item.required_approvals} />}
      {item.amount_minor != null && <Money minor={item.amount_minor} currency={currency} className="w-20 text-right text-sm font-medium max-sm:hidden" />}
      {item.can_undo && <UndoButton action={item} />}
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
