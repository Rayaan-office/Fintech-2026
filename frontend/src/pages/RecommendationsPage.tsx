import {
  ArrowRightIcon,
  BanknoteIcon,
  BellRingIcon,
  BuildingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  LandmarkIcon,
  LightbulbIcon,
  Loader2Icon,
  MailCheckIcon,
  MailIcon,
  ReceiptIcon,
  RefreshCwIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDismissRecommendation, useDraftNextStep, useFollowRecommendation, useRecommendations, useRecordBankCharge, useRefreshRecommendations } from "@/api/hooks";
import type { Action, Permission, RankedRecommendation, Recommendation, RecommendationType, RecommendationsRun } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Worded } from "@/components/AiText";
import { GettingPaidSummary, isPaymentCosts, isReminder, PaymentCosts, ReminderChip, ReminderInvoices } from "@/components/GettingPaid";
import { Initials } from "@/components/Initials";
import { IconTile, Stat } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { EvidenceView } from "@/components/recommendations/Evidence";
import { Overview, SEVERITIES } from "@/components/recommendations/Overview";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  payment_costs: { label: "Cost of getting paid", icon: BanknoteIcon },
  chase_overdue: { label: "Payment reminder", icon: BellRingIcon },
};

const PAGES: Record<string, string> = { "/health": "business health", "/cash-flow": "cash flow", "/financing": "financing" };

const SEVERITY_RANK: Record<Recommendation["severity"], number> = { urgent: 0, attention: 1, info: 2 };

/** Rows shown before "Show all": the page opens on the few that matter most. */
const FIRST_ROWS = 5;

function ranText(r: RecommendationsRun): string {
  const parts = [r.new && `${r.new} new`, r.updated && `${r.updated} updated`, r.resolved && `${r.resolved} no longer apply`].filter(Boolean);
  return parts.length ? `Checked your records: ${parts.join(", ")}.` : "Checked your records. Nothing new.";
}

export default function RecommendationsPage() {
  const recs = useRecommendations();
  const refresh = useRefreshRecommendations();
  return (
    <div className="grid grid-cols-1 gap-10">
      <PageHeader
        title="Recommendations"
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
        {(data) => (data.items.length === 0 ? <NoRecommendations /> : <Recommendations items={data.items} />)}
      </QueryView>
      <GettingPaidSummary />
    </div>
  );
}

function NoRecommendations() {
  return <EmptyState icon={LightbulbIcon} title="No recommendations right now" description="We check your records whenever new data arrives, and once a day." />;
}

/** The summary, the ranked rows, the rarely useful kinds folded at the end, and one side panel for whichever is open. */
function Recommendations({ items }: { items: RankedRecommendation[] }) {
  const currency = useCurrentUser().business.currency;
  // Most pressing first; within a severity, the server's ranking (which learns from what you act on) holds
  const ranked = [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const shown = ranked.filter((r) => !r.less_useful);
  const folded = ranked.filter((r) => r.less_useful);

  // ?open=<id> opens one directly (links from search, Home and Ask)
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

  // Drafted emails and bank charges, by recommendation, so the panel can show the confirmation card
  const [drafts, setDrafts] = useState<Record<string, Action>>({});
  const draft = useDraftNextStep();
  const bankCharge = useRecordBankCharge();
  const prepare = (r: Recommendation) => {
    const mutation = r.next_step?.kind === "record_bank_charge" ? bankCharge : draft;
    mutation.mutate(r.id, {
      onSuccess: ({ action }) => {
        setDrafts((d) => ({ ...d, [r.id]: action }));
        setOpenId(r.id);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };
  const preparing = (r: Recommendation) => (draft.isPending && draft.variables === r.id) || (bankCharge.isPending && bankCharge.variables === r.id);

  const rowProps = { openId, onOpen: setOpenId, preparing, onPrepare: prepare, currency };

  return (
    <>
      <div className="grid gap-10">
        <Overview items={items} currency={currency} />
        {shown.length > 0 && <RecommendationRows items={shown} {...rowProps} />}
        {folded.length > 0 && <LessUseful items={folded} startOpen={folded.some((r) => r.id === openId)} rowProps={rowProps} />}
      </div>

      <SidePanel open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} title={open?.title ?? ""} description={open ? RECOMMENDATION_TYPES[open.type].label : undefined}>
        {open && (
          <RecommendationDetail
            rec={open}
            currency={currency}
            draft={drafts[open.id] ?? null}
            drafting={preparing(open)}
            onPrepare={() => prepare(open)}
            onDone={() => setDrafts(({ [open.id]: _, ...rest }) => rest)}
          />
        )}
      </SidePanel>
    </>
  );
}

type RowProps = {
  openId: string | null;
  onOpen: (id: string) => void;
  preparing: (r: Recommendation) => boolean;
  onPrepare: (r: Recommendation) => void;
  currency: string;
};

/** Kinds you rarely act on sit folded at the end, never hidden. Urgent ones are never folded. */
function LessUseful({ items, startOpen, rowProps }: { items: Recommendation[]; startOpen: boolean; rowProps: RowProps }) {
  const [open, setOpen] = useState(startOpen);
  const panelId = useId();
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  return (
    <section aria-label="Less useful to you" className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Less useful to you ({items.length})
          <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        <span className="text-xs text-muted-foreground">Kinds you rarely act on</span>
      </div>
      {open && (
        <div id={panelId}>
          <RecommendationRows items={items} {...rowProps} />
        </div>
      )}
    </section>
  );
}

function RecommendationRows({ items, ...rowProps }: { items: Recommendation[] } & RowProps) {
  const [all, setAll] = useState(false);
  const reduce = useReducedMotion();
  // Never hide the one that is open
  const openIndex = items.findIndex((r) => r.id === rowProps.openId);
  const limit = Math.max(FIRST_ROWS, openIndex + 1);
  const visible = all ? items : items.slice(0, limit);
  return (
    <div className="grid gap-2">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        <AnimatePresence initial={false}>
          {visible.map((r) => (
            <motion.li
              key={r.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              aria-labelledby={`rec-${r.id}`}
              className="min-w-0"
            >
              <RecommendationRow rec={r} active={rowProps.openId === r.id} {...rowProps} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {items.length > limit && (
        <button type="button" className="justify-self-start text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** One line per recommendation: kind, title, severity and money at stake. The step's button shows on hover, and always on urgent ones. */
function RecommendationRow({ rec, active, onOpen, preparing, onPrepare, currency }: { rec: Recommendation; active: boolean } & Omit<RowProps, "openId">) {
  const type = RECOMMENDATION_TYPES[rec.type];
  const urgent = rec.severity === "urgent";
  const sev = SEVERITIES[rec.severity];
  return (
    <div
      className={cn("group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/50", active && "bg-accent/70")}
      onClick={() => onOpen(rec.id)}
    >
      <button type="button" className="flex min-w-0 flex-1 basis-48 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => (e.stopPropagation(), onOpen(rec.id))}>
        <IconTile icon={type.icon} tone={urgent ? "danger" : rec.severity === "attention" ? "warning" : "neutral"} />
        <span className="min-w-0 flex-1">
          <span id={`rec-${rec.id}`} className="block text-sm font-medium max-sm:line-clamp-2 sm:truncate">
            {rec.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
            {rec.severity !== "info" && (
              <span className={cn("inline-flex items-center gap-1 font-medium", sev.text)}>
                <span className={cn("size-1.5 rounded-full", sev.dot)} aria-hidden />
                {sev.label}
              </span>
            )}
            <span>{type.label}</span>
            <ReminderChip rec={rec} />
            <StepStatus rec={rec} />
          </span>
        </span>
      </button>
      <RowStep
        rec={rec}
        drafting={preparing(rec)}
        onPrepare={() => onPrepare(rec)}
        // Urgent ones always show it; the rest on hover or focus
        className={cn(
          urgent
            ? "max-sm:order-3 max-sm:basis-full max-sm:pl-11"
            : "max-md:hidden transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:has-[[data-state=open]]:opacity-100",
        )}
      />
      <span className="w-24 shrink-0 text-right text-sm font-medium max-md:order-2">{rec.at_stake_minor !== null && <Money minor={rec.at_stake_minor} currency={currency} />}</span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60 max-md:order-2 max-sm:hidden" aria-hidden />
    </div>
  );
}

/** Where the next step stands, when there is something to say: sent, recorded, or waiting. */
function StepStatus({ rec }: { rec: Recommendation }) {
  const status = rec.next_step?.kind ? rec.next_step.action?.status : undefined;
  if (status === "executed") {
    return rec.next_step?.kind === "record_bank_charge" ? (
      <span className="inline-flex items-center gap-1 text-positive">
        <ReceiptIcon className="size-3.5" aria-hidden /> Bank charge recorded
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-positive">
        <MailCheckIcon className="size-3.5" aria-hidden /> Email sent
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1">
        <MailIcon className="size-3.5" aria-hidden /> Draft waiting
      </span>
    );
  }
  return null;
}

type StepAct = { type: "prepare" | "open"; label: string } | { type: "link"; label: string; href: string };

/** What the next step does, as a short button label, or null when this person can't take it here. */
function stepAct(rec: Recommendation, can: (p: Permission) => boolean): StepAct | null {
  const step = rec.next_step;
  if (!step || step.action?.status === "executed") return null;
  if (step.kind) {
    if (!can(step.kind === "record_bank_charge" ? "reconcile" : "send_reminder")) return null;
    if (step.action?.status === "pending") return { type: "open", label: "Open draft" };
    return { type: "prepare", label: step.kind === "record_bank_charge" ? "Record charge" : step.action ? "Draft again" : "Draft email" };
  }
  if (step.href) return { type: "link", label: `Go to ${PAGES[step.href] ?? "the page"}`, href: step.href };
  return null;
}

/** The step in words, what happens before anything goes out, and one short button to do it. */
function StepCard({ rec, act, drafting, onPrepare, children }: { rec: Recommendation; act: StepAct; drafting: boolean; onPrepare: () => void; children?: React.ReactNode }) {
  const follow = useFollowRecommendation();
  const step = rec.next_step!;
  const note = safetyNote(rec);
  const words = step.label === "For information" && act.type === "link" ? `More on the ${PAGES[act.href] ?? "linked"} page.` : step.label;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="text-xs font-medium text-muted-foreground">Next step</p>
        <p className="text-sm">{words}</p>
        {note && act.type !== "open" && <p className="text-xs text-muted-foreground">{note}</p>}
        {act.type === "open" && <p className="text-xs text-muted-foreground">A draft is waiting for approval.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {act.type === "link" ? (
          <Button asChild size="sm">
            <Link to={act.href} onClick={() => follow.mutate(rec.id)}>
              {act.label} <ArrowRightIcon aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button size="sm" onClick={onPrepare} disabled={drafting}>
            {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
            {act.label}
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}

/** One short button on the row. It opens a small card that says exactly what will happen, then does it. */
function RowStep({ rec, drafting, onPrepare, className }: { rec: Recommendation; drafting: boolean; onPrepare: () => void; className?: string }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  const act = stepAct(rec, can);
  if (!act) return null;
  return (
    // Clicks here (and inside the card, which React bubbles through its portal) don't open the panel
    <div className={cn("shrink-0", className)} onClick={(e) => e.stopPropagation()}>
      {act.type === "open" ? (
        <Button size="sm" variant="secondary" onClick={onPrepare} disabled={drafting} aria-label={`Open draft: ${rec.title}`}>
          {drafting ? <Loader2Icon className="animate-spin" aria-hidden /> : <MailIcon aria-hidden />} Open draft
        </Button>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant={rec.severity === "info" ? "secondary" : "default"} aria-label={`Take action: ${rec.title}`} disabled={drafting}>
              {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
              Take action
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-4">
            <StepCard
              rec={rec}
              act={act}
              drafting={drafting}
              onPrepare={() => {
                setOpen(false);
                onPrepare();
              }}
            >
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </StepCard>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** The same step in the panel, already in words, beside Dismiss. */
function PanelStep({ rec, drafting, onPrepare }: { rec: Recommendation; drafting: boolean; onPrepare: () => void }) {
  const can = useCan();
  const step = rec.next_step;
  const act = stepAct(rec, can);
  if (act) {
    return (
      <StepCard rec={rec} act={act} drafting={drafting} onPrepare={onPrepare}>
        <DismissButton rec={rec} />
      </StepCard>
    );
  }
  const done = step?.kind && step.action?.status === "executed";
  return (
    <div className="grid gap-3">
      {done ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-positive">
          {step.kind === "record_bank_charge" ? <ReceiptIcon className="size-4" aria-hidden /> : <MailCheckIcon className="size-4" aria-hidden />}
          {step.kind === "record_bank_charge" ? "Bank charge recorded" : "Email sent"}
        </span>
      ) : (
        // Advice with nothing to click, or a step this person can't take; payment costs show it as their tip
        step &&
        !isPaymentCosts(rec.getting_paid) && (
          <div className="grid gap-1">
            <p className="text-xs font-medium text-muted-foreground">Next step</p>
            <p className="inline-flex items-start gap-1.5 text-sm">
              <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              {step.label}
            </p>
          </div>
        )
      )}
      <div>
        <DismissButton rec={rec} />
      </div>
    </div>
  );
}

function safetyNote(rec: Recommendation): string | null {
  const step = rec.next_step;
  if (!step?.kind || step.action?.status === "executed") return null;
  return step.kind === "record_bank_charge" ? "Nothing changes until a finance manager or business owner approves it." : "Nothing is sent until someone approves the draft.";
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
      <Button variant="ghost" disabled={dismiss.isPending} onClick={() => go(false)} title="A new change of bank details is always shown.">
        Dismiss
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" disabled={dismiss.isPending}>
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
  currency,
  draft,
  drafting,
  onPrepare,
  onDone,
}: {
  rec: Recommendation;
  currency: string;
  draft: Action | null;
  drafting: boolean;
  onPrepare: () => void;
  onDone: () => void;
}) {
  const related = rec.next_step?.related_action_ids ?? [];
  const sev = SEVERITIES[rec.severity];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          {rec.counterparty && (
            <span className="flex items-center gap-2.5">
              <Initials name={rec.counterparty} />
              <span className="font-medium">{rec.counterparty}</span>
            </span>
          )}
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1 font-medium", sev.text)}>
              <span className={cn("size-1.5 rounded-full", sev.dot)} aria-hidden />
              {sev.label}
            </span>
            <span>{formatRelative(rec.updated_at ?? rec.created_at)}</span>
          </span>
        </div>
        {rec.at_stake_minor !== null && <Stat label="At stake" value={<Money minor={rec.at_stake_minor} currency={currency} />} className="text-right" />}
      </div>

      {draft ? (
        <section aria-label={draft.type === "record_bank_charge" ? "Bank charge to record" : "Draft email"} className="grid gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{draft.type === "record_bank_charge" ? "The bank charge to record" : "The draft email"}</h3>
          <ActionConfirmation confirmation={draft} onDone={onDone} />
        </section>
      ) : (
        <PanelStep rec={rec} drafting={drafting} onPrepare={onPrepare} />
      )}

      {related.length > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-warning-soft/60 px-3 py-2.5 text-sm">
          <span className="flex-1">{related.length === 1 ? "An approval about this is waiting." : `${related.length} approvals about this are waiting.`}</span>
          <Link to={`/inbox?action=${encodeURIComponent(related[0]!)}`} className="font-medium text-primary hover:underline">
            Review it in the inbox
          </Link>
        </p>
      )}

      <EvidenceView evidence={isReminder(rec.getting_paid) ? [] : rec.evidence} />
      {isReminder(rec.getting_paid) && <ReminderInvoices detail={rec.getting_paid} />}
      {isPaymentCosts(rec.getting_paid) && <PaymentCosts detail={rec.getting_paid} />}

      <div className="grid gap-3 border-t pt-5">
        <Worded wording={rec.summary} />
        <WhyHint why={rec.why} />
      </div>
    </div>
  );
}
