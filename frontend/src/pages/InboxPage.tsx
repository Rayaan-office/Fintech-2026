import { CheckCheckIcon, InboxIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useApproveAction, useInbox } from "@/api/hooks";
import type { InboxItem, InboxTab } from "@/api/types";
import { ActionConfirmation, approveBlockedReason } from "@/components/ActionConfirmation";
import { ApprovalBadge } from "@/components/ApprovalBadge";
import { DocumentReview } from "@/components/DocumentReview";
import { Initials } from "@/components/Initials";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const TABS: { id: InboxTab; label: string; empty: string }[] = [
  { id: "to_review", label: "To review", empty: "Nothing to check. New documents and suggested matches will appear here." },
  { id: "needs_approval", label: "Needs approval", empty: "Nothing waiting for approval." },
  { id: "done", label: "Done", empty: "Items you've handled will be listed here." },
];

export default function InboxPage() {
  const inbox = useInbox();
  return (
    <div className="grid gap-6">
      <PageHeader title="Inbox" description="Everything waiting for a person, with the reason it needs one." />
      <QueryView
        query={inbox}
        loading={<ListSkeleton rows={6} />}
        empty={<EmptyState icon={InboxIcon} title="Your inbox is empty" description="When a document needs checking or an action needs approval, it will appear here." />}
      >
        {(data) => <InboxContent items={data.items} counts={data.counts} />}
      </QueryView>
    </div>
  );
}

function InboxContent({ items, counts }: { items: InboxItem[]; counts: Record<InboxTab, number> }) {
  const me = useCurrentUser();
  const approve = useApproveAction();
  const [tab, setTab] = useState<InboxTab>(counts.needs_approval > 0 && counts.to_review === 0 ? "needs_approval" : "to_review");
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(() => items.filter((i) => i.tab === tab), [items, tab]);
  const current = visible[Math.min(cursor, visible.length - 1)];
  const open = items.find((i) => i.id === openId) ?? null;
  const canQuickApprove = (i: InboxItem) => i.tab === "needs_approval" && i.confirmation !== null && approveBlockedReason(i.confirmation, me) === null && !i.confirmation.approvals.some((a) => a.user_id === me.user.id);

  const keys = { enabled: openId === null };
  useHotkeys("j", () => setCursor((c) => Math.min(c + 1, visible.length - 1)), keys, [visible.length]);
  useHotkeys("k", () => setCursor((c) => Math.max(c - 1, 0)), keys);
  useHotkeys("enter", () => current && setOpenId(current.id), keys, [current]);
  useHotkeys("e", () => current && setOpenId(current.id), keys, [current]);
  useHotkeys("x", () => current && canQuickApprove(current) && toggle(current.id), keys, [current]);
  useHotkeys(
    "a",
    () => {
      if (!current) return;
      if (!current.confirmation) return setOpenId(current.id);
      const blocked = approveBlockedReason(current.confirmation, me);
      if (blocked) return toast(blocked);
      // Level 3 and 4 always open the card so the person sees exactly what will happen
      if (current.level >= 3) return setOpenId(current.id);
      approveOne(current);
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

  function approveOne(item: InboxItem) {
    if (!item.confirmation) return;
    approve.mutate(item.confirmation.action_id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error(errorMessage(err)),
    });
  }

  async function approveSelected() {
    const chosen = visible.filter((i) => selected.has(i.id) && i.confirmation);
    let ok = 0;
    for (const item of chosen) {
      try {
        await approve.mutateAsync(item.confirmation!.action_id);
        ok += 1;
      } catch (err) {
        toast.error(`${item.sentence}: ${errorMessage(err)}`);
      }
    }
    setSelected(new Set());
    if (ok > 0) toast.success(`Approved ${ok} ${ok === 1 ? "item" : "items"}.`);
  }

  const selectedCount = visible.filter((i) => selected.has(i.id)).length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as InboxTab);
            setCursor(0);
            setSelected(new Set());
          }}
        >
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
                {t.id !== "done" && counts[t.id] > 0 && <span className="text-xs text-muted-foreground tabular">{counts[t.id]}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          {selectedCount > 0 && (
            <Button onClick={() => void approveSelected()} disabled={approve.isPending}>
              <CheckCheckIcon aria-hidden /> Approve {selectedCount} selected
            </Button>
          )}
          <p className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> to move, <Kbd>A</Kbd> approve, <Kbd>E</Kbd> edit
          </p>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={InboxIcon} title="All clear" description={TABS.find((t) => t.id === tab)!.empty} />
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" aria-label={TABS.find((t) => t.id === tab)!.label}>
          <AnimatePresence initial={false}>
            {visible.map((item, i) => (
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
                {canQuickApprove(item) ? (
                  <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} aria-label={`Select: ${item.sentence}`} />
                ) : (
                  item.tab === "needs_approval" && <span className="size-4 shrink-0" aria-hidden />
                )}
                {item.counterparty ? <Initials name={item.counterparty} /> : <span className="size-8 shrink-0" aria-hidden />}
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setCursor(i); setOpenId(item.id); }}>
                  <span className="block text-sm font-medium">{item.sentence}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.why} · {formatRelative(item.created_at)}
                  </span>
                </button>
                <ApprovalBadge level={item.level} className="max-sm:hidden" />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <FocusedPanel open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} title={open?.sentence ?? ""} description={open?.why}>
        {open &&
          (open.document_id ? (
            <DocumentReview id={open.document_id} onDone={() => setOpenId(null)} />
          ) : open.confirmation ? (
            <div className="mx-auto max-w-xl">
              <ActionConfirmation confirmation={open.confirmation} onDone={() => setOpenId(null)} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing more to do here.</p>
          ))}
      </FocusedPanel>
    </>
  );
}
