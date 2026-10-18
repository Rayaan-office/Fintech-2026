import {
  BuildingIcon,
  ChevronDownIcon,
  ClockIcon,
  LandmarkIcon,
  LightbulbIcon,
  Loader2Icon,
  MailCheckIcon,
  RefreshCwIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDismissRecommendation, useDraftNextStep, useFollowRecommendation, useRecommendations, useRefreshRecommendations } from "@/api/hooks";
import type { Action, RankedRecommendation, Recommendation, RecommendationType, RecommendationsRun } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Worded } from "@/components/AiText";
import { Initials } from "@/components/Initials";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WhyHint } from "@/components/WhyHint";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const RECOMMENDATION_TYPES: Record<RecommendationType, { label: string; icon: LucideIcon; risky?: boolean }> = {
  supplier_details_changed: { label: "Supplier details changed", icon: BuildingIcon },
  bank_details_changed: { label: "Bank details changed", icon: LandmarkIcon, risky: true },
  price_rise: { label: "Price rise", icon: TrendingUpIcon },
  slow_payer: { label: "Slow-paying customer", icon: ClockIcon },
  spending_creep: { label: "Spending creep", icon: WalletIcon },
  customer_concentration: { label: "Reliance on one customer", icon: UsersIcon },
};

const PAGES: Record<string, string> = { "/health": "business health", "/cash-flow": "cash flow", "/financing": "financing" };

function ranText(r: RecommendationsRun): string {
  const parts = [r.new && `${r.new} new`, r.updated && `${r.updated} updated`, r.resolved && `${r.resolved} no longer apply`].filter(Boolean);
  return parts.length ? `Checked your records: ${parts.join(", ")}.` : "Checked your records. Nothing new.";
}

export default function RecommendationsPage() {
  const recs = useRecommendations();
  const refresh = useRefreshRecommendations();
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Recommendations"
        description="Things we spotted in your records, each with the numbers behind it and one next step."
        actions={
          <Button
            variant="secondary"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(undefined, { onSuccess: (r) => toast(ranText(r)), onError: (err) => toast.error(errorMessage(err)) })}
          >
            {refresh.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <RefreshCwIcon aria-hidden />} Check now
          </Button>
        }
      />
      <QueryView query={recs} loading={<ListSkeleton rows={4} />} empty={<NoRecommendations />}>
        {(data) => (data.items.length === 0 ? <NoRecommendations /> : <RankedList items={data.items} />)}
      </QueryView>
    </div>
  );
}

/** Kinds you rarely act on sit folded at the end, never hidden. Urgent ones are never folded. */
function RankedList({ items }: { items: RankedRecommendation[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const shown = items.filter((r) => !r.less_useful);
  const folded = items.filter((r) => r.less_useful);
  return (
    <>
      {shown.length > 0 && <RecommendationList items={shown} />}
      {folded.length > 0 && (
        <section aria-label="Less useful to you" className="grid gap-4">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-left text-sm hover:bg-accent/60"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">Less useful to you ({folded.length})</span>
              <span className="block text-muted-foreground">Kinds you've rarely acted on. We keep them here in case you need them.</span>
            </span>
            <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
          </button>
          {open && (
            <div id={panelId}>
              <RecommendationList items={folded} />
            </div>
          )}
        </section>
      )}
    </>
  );
}

function NoRecommendations() {
  return (
    <EmptyState
      icon={LightbulbIcon}
      title="No recommendations right now"
      description="We review your records whenever new data arrives and once a day. Anything worth your attention will appear here."
    />
  );
}

function RecommendationList({ items }: { items: Recommendation[] }) {
  const currency = useCurrentUser().business.currency;
  // Drafted emails, by recommendation, so the side panel can show the confirmation card
  const [drafts, setDrafts] = useState<Record<string, Action>>({});
  const draft = useDraftNextStep();
  // ?open=<id> opens one directly (links from Ask)
  const [params, setParams] = useSearchParams();
  const openId = params.get("open");
  const setOpenId = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set("open", id);
        else p.delete("open");
        return p;
      },
      { replace: true },
    );
  const open = items.find((r) => r.id === openId) ?? null;

  const startDraft = (r: Recommendation) =>
    draft.mutate(r.id, {
      onSuccess: ({ action }) => {
        setDrafts((d) => ({ ...d, [r.id]: action }));
        setOpenId(r.id);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });

  return (
    <>
      <ul className="grid gap-4">
        <AnimatePresence initial={false}>
          {items.map((r) => {
            const type = RECOMMENDATION_TYPES[r.type];
            const Icon = type.icon;
            return (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.2 }}
                aria-labelledby={`rec-${r.id}`}
                className={cn("min-w-0 rounded-xl border bg-card shadow-card", openId === r.id && "ring-2 ring-primary/40")}
              >
                <div className="flex flex-wrap items-start gap-4 p-5">
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg",
                      r.severity === "urgent" ? "bg-danger-soft text-danger" : type.risky || r.severity === "attention" ? "bg-warning-soft text-warning" : "bg-primary-soft text-primary",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="grid min-w-0 flex-1 basis-56 gap-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-xs font-medium text-muted-foreground">{type.label}</span>
                      <SeverityBadge severity={r.severity} />
                      <span className="text-xs text-muted-foreground">{formatRelative(r.updated_at ?? r.created_at)}</span>
                    </div>
                    <h2 id={`rec-${r.id}`} className="text-[15px] font-semibold">
                      {r.title}
                    </h2>
                    <Worded wording={r.summary} />
                    <WhyHint why={r.why} />
                  </div>
                  {r.at_stake_minor !== null && (
                    <div className="text-right max-sm:w-full max-sm:text-left">
                      <div className="text-xs text-muted-foreground">At stake</div>
                      <div className="text-lg font-semibold">
                        <Money minor={r.at_stake_minor} currency={currency} />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
                  <NextStep rec={r} drafting={draft.isPending && draft.variables === r.id} onDraft={() => startDraft(r)} />
                  <Button variant="secondary" onClick={() => setOpenId(r.id)}>
                    See before and after
                  </Button>
                  <DismissButton rec={r} />
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      <SidePanel
        open={open !== null}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={open?.title ?? ""}
        description={open ? RECOMMENDATION_TYPES[open.type].label : undefined}
      >
        {open && (
          <RecommendationDetail
            rec={open}
            draft={drafts[open.id] ?? null}
            drafting={draft.isPending && draft.variables === open.id}
            onDraft={() => startDraft(open)}
            onDone={() => setDrafts(({ [open.id]: _, ...rest }) => rest)}
          />
        )}
      </SidePanel>
    </>
  );
}

function SeverityBadge({ severity }: { severity: Recommendation["severity"] }) {
  if (severity === "urgent") return <Badge variant="danger">Urgent</Badge>;
  if (severity === "attention") return <Badge variant="warning">Worth a look</Badge>;
  return null;
}

/** The one next step: draft the email, open the draft already waiting, or go to the page that helps. */
function NextStep({ rec, drafting, onDraft }: { rec: Recommendation; drafting: boolean; onDraft: () => void }) {
  const can = useCan();
  const follow = useFollowRecommendation();
  const step = rec.next_step;
  if (!step) return null;
  if (step.kind) {
    const status = step.action?.status;
    if (status === "executed") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-positive">
          <MailCheckIcon className="size-4" aria-hidden /> Email sent
        </span>
      );
    }
    if (!can("send_reminder")) return <span className="text-sm text-muted-foreground">{step.label}</span>;
    return (
      <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left" onClick={onDraft} disabled={drafting} aria-describedby={status === "pending" ? `waiting-${rec.id}` : undefined}>
        {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
        {status === "pending" ? "Open the draft email" : status ? "Draft the email again" : step.label}
        {status === "pending" && (
          <span id={`waiting-${rec.id}`} className="sr-only">
            A draft is waiting for approval.
          </span>
        )}
      </Button>
    );
  }
  if (step.href) {
    const page = PAGES[step.href];
    return (
      <Button asChild className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left" variant={rec.severity === "info" ? "secondary" : "default"}>
        <Link to={step.href} onClick={() => follow.mutate(rec.id)}>
          {step.label === "For information" && page ? `Open ${page}` : step.label}
        </Link>
      </Button>
    );
  }
  return <span className="text-sm text-muted-foreground">{step.label}</span>;
}

/** Dismissing can also stop this kind for this supplier or customer. Changed bank details always come back. */
function DismissButton({ rec }: { rec: Recommendation }) {
  const dismiss = useDismissRecommendation();
  const go = (mute: boolean) =>
    dismiss.mutate(
      { id: rec.id, mute },
      {
        onSuccess: ({ muted }) =>
          toast(muted ? `Dismissed. We won't raise this again${rec.counterparty ? ` for ${rec.counterparty}` : ""}.` : "Dismissed. We'll raise it again if something changes."),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  if (!rec.can_mute) {
    return (
      <Button variant="ghost" className="ml-auto" disabled={dismiss.isPending} onClick={() => go(false)} title="A new change of bank details is always shown.">
        Dismiss
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="ml-auto" disabled={dismiss.isPending}>
          Dismiss <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => go(false)}>
          <span className="grid">
            <span>Dismiss this one</span>
            <span className="text-xs text-muted-foreground">We'll raise it again if something changes</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go(true)}>
          <span className="grid">
            <span>Don't show this kind again{rec.counterparty ? ` for ${rec.counterparty}` : ""}</span>
            <span className="text-xs text-muted-foreground">{RECOMMENDATION_TYPES[rec.type].label}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RecommendationDetail({
  rec,
  draft,
  drafting,
  onDraft,
  onDone,
}: {
  rec: Recommendation;
  draft: Action | null;
  drafting: boolean;
  onDraft: () => void;
  onDone: () => void;
}) {
  const related = rec.next_step?.related_action_ids ?? [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {rec.counterparty && (
        <div className="flex items-center gap-3">
          <Initials name={rec.counterparty} size="lg" />
          <span className="font-medium">{rec.counterparty}</span>
        </div>
      )}
      <Worded wording={rec.summary} />
      {rec.evidence.length > 0 && (
        <section aria-label="Before and after" className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-2 font-medium">
                  <span className="sr-only">What</span>
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  Before
                </th>
                <th scope="col" className="py-2 font-medium">
                  Now
                </th>
              </tr>
            </thead>
            <tbody>
              {rec.evidence.map((e, i) => (
                <tr key={`${e.label}-${i}`} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">
                    {e.label}
                  </th>
                  <td className="break-words py-2 pr-2 tabular">{e.before || <span className="text-muted-foreground">–</span>}</td>
                  <td className="break-words py-2 font-medium tabular">{e.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <WhyHint why={rec.why} />
      {related.length > 0 && (
        <p className="text-sm">
          {related.length === 1 ? "An approval about this is waiting. " : `${related.length} approvals about this are waiting. `}
          <Link to={`/inbox?action=${encodeURIComponent(related[0]!)}`} className="font-medium text-primary hover:underline">
            Review it in the inbox
          </Link>
        </p>
      )}
      {draft ? (
        <section aria-label="Draft email" className="grid gap-2">
          <h3 className="text-sm font-medium">The draft email</h3>
          <ActionConfirmation confirmation={draft} onDone={onDone} />
        </section>
      ) : (
        rec.next_step?.kind &&
        rec.next_step.action?.status !== "executed" && (
          <PanelDraftButton label={rec.next_step.action?.status === "pending" ? "Open the draft email" : rec.next_step.label} drafting={drafting} onDraft={onDraft} />
        )
      )}
    </div>
  );
}

function PanelDraftButton({ label, drafting, onDraft }: { label: string; drafting: boolean; onDraft: () => void }) {
  const can = useCan();
  if (!can("send_reminder")) return null;
  return (
    <div>
      <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left" onClick={onDraft} disabled={drafting}>
        {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
        {label}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">Nothing is sent until someone approves the draft.</p>
    </div>
  );
}
