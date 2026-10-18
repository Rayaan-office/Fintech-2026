import { BrainCircuitIcon, Building2Icon, LightbulbIcon, Loader2Icon, RotateCcwIcon, ShieldCheckIcon, XIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useLearning, useResetLearning } from "@/api/hooks";
import type { LearningReset, LearningSummary } from "@/api/types";
import { Initials } from "@/components/Initials";
import { InfoPopover, Section, StatStrip } from "@/components/kit";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function LearningPage() {
  const learning = useLearning();
  return (
    <div className="grid grid-cols-1 gap-8">
      <QueryView
        query={learning}
        loading={<CardsSkeleton count={3} />}
        empty={<EmptyState icon={BrainCircuitIcon} title="Nothing learned yet" description="When you correct a bill or act on a recommendation, we learn from it and show it here." />}
      >
        {(data) => <Learned data={data} />}
      </QueryView>
    </div>
  );
}

/** "3 min" or "30 sec" from minutes. */
export function timeSaved(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`;
  return `${minutes.toLocaleString("en-GB", { maximumFractionDigits: 1 })} min`;
}

function Learned({ data }: { data: LearningSummary }) {
  const n = data.numbers;
  const nothing = data.suppliers.length === 0 && data.recommendations.length === 0 && n.fields_filled === 0;
  return (
    <>
      <PageHeader
        title="What we've learned"
        actions={data.can_reset && !nothing ? <ResetButton what={{ scope: "all" }} label="Reset everything" confirm="Forget everything we've learned?" /> : undefined}
      />

      <StatStrip
        items={[
          {
            label: (
              <span className="inline-flex items-center gap-0.5">
                Time saved
                <InfoPopover label="How we count time saved" title="How we count it" className="-my-1 size-5">
                  <p>
                    {n.fields_kept} {n.fields_kept === 1 ? "value" : "values"} filled in from your past corrections and kept. {data.assumptions.join(" ")}
                  </p>
                </InfoPopover>
              </span>
            ),
            value: timeSaved(n.minutes_saved),
            note: `${n.documents_helped} ${n.documents_helped === 1 ? "document" : "documents"} helped`,
          },
          { label: "Filled in for you", value: n.fields_filled, note: n.fields_undone ? `${n.fields_undone} undone` : "None undone" },
          {
            label: "Top suggestion acted on",
            value: n.top_acted_share === null ? "–" : formatPercent(n.top_acted_share * 100),
            note: n.top_decisions ? `${n.top_acted_on} of ${n.top_decisions} times it was first in the list` : "No decisions yet",
          },
          {
            label: "Suggestions acted on",
            value: n.acted_share === null ? "–" : formatPercent(n.acted_share * 100),
            note: n.decisions ? `${n.acted_on} of ${n.decisions} decisions` : "No decisions yet",
          },
        ]}
      />

      <Section
        className="grid-cols-1"
        title="From your corrections"
        aside={data.suppliers.length > 0 ? data.suppliers.length : undefined}
        actions={
          <InfoPopover label="How we learn from corrections" title="Learning from corrections">
            <p>
              After the same correction on {data.rules.learn_after} approved documents from one supplier, we fill it in ourselves next time and mark it beside the field, with Undo. A different correction stops it.
            </p>
          </InfoPopover>
        }
      >
        {data.suppliers.length === 0 ? (
          <QuietEmpty icon={Building2Icon} title="No corrections learned yet" note={`Correct the same thing on ${data.rules.learn_after} approved bills from one supplier and we'll remember it.`} />
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {data.suppliers.map((s) => (
              <li key={s.counterparty_id} aria-label={s.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
                <span className="flex min-w-0 items-center gap-3 sm:w-56 sm:shrink-0">
                  <Initials name={s.name} />
                  <span className="grid min-w-0">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">{s.kind === "customer" ? "Customer" : "Supplier"}</span>
                  </span>
                </span>
                <ul aria-label={`Learned for ${s.name}`} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {s.items.map((i) => (
                    <li key={i.field} title={i.sentence} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border bg-background text-xs", data.can_reset ? "pr-0.5 pl-2.5" : "px-2.5")}>
                      <span aria-hidden>
                        <span className="text-muted-foreground">{i.label}</span> <span className="font-medium">{i.value_label}</span>
                        <span className="ml-1.5 text-muted-foreground tabular">×{i.corrections}</span>
                      </span>
                      <span className="sr-only">{i.sentence}</span>
                      {data.can_reset && <ResetButton what={{ scope: "field", counterparty_id: s.counterparty_id, field: i.field }} label={`Forget ${i.label}`} iconOnly />}
                    </li>
                  ))}
                </ul>
                {data.can_reset && <ResetButton what={{ scope: "supplier", counterparty_id: s.counterparty_id }} label="Forget all" confirm={`Forget everything we learned about ${s.name}?`} />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        className="grid-cols-1"
        title="From your decisions"
        aside={data.recommendations.length > 0 ? data.recommendations.length : undefined}
        actions={
          <InfoPopover label="How we learn from decisions" title="Learning from decisions">
            <p>We show the kinds of suggestion you act on higher, within the same level of importance.</p>
            <p>
              A minor kind you act on less than {formatPercent(data.rules.fold_below * 100)} of the time, after {data.rules.fold_after} decisions, is folded under "Less useful to you". Urgent items and changed bank details always stay at the top.
            </p>
          </InfoPopover>
        }
      >
        {data.recommendations.length === 0 ? (
          <QuietEmpty icon={LightbulbIcon} title="No decisions yet" note="Act on or dismiss a recommendation and we'll learn which kinds are useful to you." />
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {data.recommendations.map((k) => (
              <li key={k.kind} aria-label={k.label} title={k.sentence} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[14rem_minmax(0,1fr)_auto] sm:px-5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{k.label}</span>
                  {k.less_useful && <Badge variant="neutral">Less useful to you</Badge>}
                </span>
                <WinsBar acted={k.acted_on} declined={k.turned_down} share={k.acted_share} />
                <span className="col-start-2 row-start-1 flex items-center justify-end sm:col-start-auto sm:row-start-auto">
                  <span className="sr-only">{k.sentence}</span>
                  {data.can_reset && <ResetButton what={{ scope: "kind", kind: k.kind }} label={`Reset ${k.label}`} iconOnly />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        We never learn {data.never_learned.join(", ")}. Learning never approves anything by itself.
      </p>
    </>
  );
}

/** Nothing here yet, said in one quiet line. */
function QuietEmpty({ icon: Icon, title, note }: { icon: LucideIcon; title: string; note: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
    </div>
  );
}

/** Acted on against turned down, as one bar: the green part is how often it was useful. */
function WinsBar({ acted, declined, share }: { acted: number; declined: number; share: number }) {
  const total = acted + declined;
  const label = `Acted on ${formatPercent(share * 100)}`;
  return (
    <span className="col-span-2 flex w-full max-w-md min-w-0 items-center gap-3 sm:col-span-1">
      <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
        <span className="h-full bg-positive" style={{ width: `${total ? (acted / total) * 100 : 0}%` }} />
        <span className="h-full bg-muted-foreground/25" style={{ width: `${total ? (declined / total) * 100 : 0}%` }} />
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular" aria-hidden>
        <span className="font-medium text-foreground">{acted}</span> of {total}
      </span>
    </span>
  );
}

/** A reset, asking first when it forgets more than one thing. */
function ResetButton({ what, label, confirm, iconOnly = false }: { what: LearningReset; label: string; confirm?: string; iconOnly?: boolean }) {
  const reset = useResetLearning();
  const [asking, setAsking] = useState(false);
  const go = () =>
    reset.mutate(what, {
      onSuccess: () => {
        setAsking(false);
        toast.success("Done. We'll learn again from your next corrections and decisions.");
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  const button = iconOnly ? (
    <Button variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" disabled={reset.isPending} onClick={confirm ? () => setAsking(true) : go} aria-label={label} title={label}>
      {reset.isPending ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : <XIcon className="size-3.5" aria-hidden />}
    </Button>
  ) : (
    <Button variant="ghost" size="sm" disabled={reset.isPending} onClick={confirm ? () => setAsking(true) : go}>
      {reset.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <RotateCcwIcon aria-hidden />} {label}
    </Button>
  );
  if (!confirm) return button;
  return (
    <>
      {button}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm}</DialogTitle>
            <DialogDescription>Your corrections stay in the activity history. We just stop learning from them, and start again from your next ones.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={reset.isPending} onClick={go}>
              {reset.isPending && <Loader2Icon className="animate-spin" aria-hidden />} Forget it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
