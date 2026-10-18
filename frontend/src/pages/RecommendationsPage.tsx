import {
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
import type { Action, RankedRecommendation, Recommendation, RecommendationType, RecommendationsRun } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Worded } from "@/components/AiText";
import { BankChargeStep, GettingPaidSummary, isPaymentCosts, isReminder, PaymentCosts, ReminderChip, ReminderInvoices } from "@/components/GettingPaid";
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

/** One line per recommendation: kind, title, severity and money at stake. The next step shows on hover, and always on urgent ones. */
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
        // Urgent: its own line under the title, so the full step reads and the title isn't squeezed
        className={cn(urgent ? "order-3 max-w-none basis-full pl-11" : "max-md:hidden transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}
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

/** The next step as a small pill on the row: draft, open the draft, record the charge, or go to the page that helps. */
function RowStep({ rec, drafting, onPrepare, className }: { rec: Recommendation; drafting: boolean; onPrepare: () => void; className?: string }) {
  const can = useCan();
  const follow = useFollowRecommendation();
  const step = rec.next_step;
  if (!step) return null;
  const variant = rec.severity === "info" ? "secondary" : "default";
  const wrap = (child: React.ReactNode) => (
    <div className={cn("min-w-0 max-w-80 shrink", className)} onClick={(e) => e.stopPropagation()}>
      {child}
    </div>
  );
  const status = step.action?.status;
  if (status === "executed") return null;
  if (step.kind === "record_bank_charge") {
    return can("reconcile") ? wrap(<BankChargeStep rec={rec} preparing={drafting} onPrepare={onPrepare} size="sm" />) : null;
  }
  if (step.kind) {
    if (!can("send_reminder")) return null;
    const label = status === "pending" ? "Open the draft email" : status ? "Draft the email again" : step.label;
    return wrap(
      <Button size="sm" variant={variant} className="max-w-full" title={label} onClick={onPrepare} disabled={drafting} aria-describedby={status === "pending" ? `waiting-${rec.id}` : undefined}>
        {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
        <span className="truncate">{label}</span>
        {status === "pending" && (
          <span id={`waiting-${rec.id}`} className="sr-only">
            A draft is waiting for approval.
          </span>
        )}
      </Button>,
    );
  }
  if (step.href) {
    const page = PAGES[step.href];
    return wrap(
      <Button asChild size="sm" variant={variant} className="max-w-full" title={step.label}>
        <Link to={step.href} onClick={() => follow.mutate(rec.id)}>
          <span className="truncate">{step.label === "For information" && page ? `Open ${page}` : step.label}</span>
        </Link>
      </Button>,
    );
  }
  return null;
}

/** The same next step in the panel, full width of words, with what happens before anything goes out. */
function PanelStep({ rec, drafting, onPrepare }: { rec: Recommendation; drafting: boolean; onPrepare: () => void }) {
  const can = useCan();
  const follow = useFollowRecommendation();
  const step = rec.next_step;
  if (!step) return null;
  const status = step.action?.status;
  if (step.kind === "record_bank_charge") {
    return <BankChargeStep rec={rec} preparing={drafting} onPrepare={onPrepare} className="h-auto min-h-9 whitespace-normal py-2 text-left" />;
  }
  if (step.kind) {
    if (status === "executed") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-positive">
          <MailCheckIcon className="size-4" aria-hidden /> Email sent
        </span>
      );
    }
    if (!can("send_reminder")) return <span className="text-sm text-muted-foreground">{step.label}</span>;
    return (
      <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left" onClick={onPrepare} disabled={drafting}>
        {drafting && <Loader2Icon className="animate-spin" aria-hidden />}
        {status === "pending" ? "Open the draft email" : status ? "Draft the email again" : step.label}
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
  // Payment costs show the same advice as their tip, beside the comparison
  if (isPaymentCosts(rec.getting_paid)) return null;
  return (
    <span className="inline-flex items-start gap-1.5 text-sm">
      <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      {step.label}
    </span>
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
  const note = safetyNote(rec);
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
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <PanelStep rec={rec} drafting={drafting} onPrepare={onPrepare} />
            <DismissButton rec={rec} />
          </div>
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
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
