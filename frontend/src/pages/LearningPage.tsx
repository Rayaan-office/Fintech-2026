import { BrainCircuitIcon, Building2Icon, LightbulbIcon, Loader2Icon, RotateCcwIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useLearning, useResetLearning } from "@/api/hooks";
import type { LearningReset, LearningSummary } from "@/api/types";
import { Headline, PageHeader, SummaryCard } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPercent } from "@/lib/format";

export default function LearningPage() {
  const learning = useLearning();
  return (
    <div className="grid grid-cols-1 gap-6">
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
        description={`We learn from your corrections and decisions. It all stays in our records and is never sent to the AI. We never learn ${data.never_learned.join(", ")}.`}
        actions={data.can_reset && !nothing ? <ResetButton what={{ scope: "all" }} label="Reset everything" confirm="Forget everything we've learned?" /> : undefined}
      />

      <Headline
        label="Time saved by values we filled in"
        value={timeSaved(n.minutes_saved)}
        note={`${n.fields_kept} ${n.fields_kept === 1 ? "value" : "values"} filled in from your past corrections and kept. ${data.assumptions.join(" ")}`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Filled in for you" value={n.fields_filled} note={n.fields_undone ? `${n.fields_undone} undone by a person` : "None undone so far"} />
        <SummaryCard
          label="Top recommendation acted on"
          value={n.top_acted_share === null ? "–" : formatPercent(n.top_acted_share * 100)}
          note={n.top_decisions ? `${n.top_acted_on} of ${n.top_decisions} times it was first in the list` : "No decisions yet"}
        />
        <SummaryCard
          label="Recommendations acted on"
          value={n.acted_share === null ? "–" : formatPercent(n.acted_share * 100)}
          note={n.decisions ? `${n.acted_on} of ${n.decisions} decisions` : "No decisions yet"}
        />
      </div>

      <section aria-labelledby="learned-corrections" className="grid gap-3">
        <h2 id="learned-corrections" className="text-[15px] font-semibold">
          From your corrections
        </h2>
        <p className="text-sm text-muted-foreground">
          After the same correction on {data.rules.learn_after} approved documents from one supplier, we fill it in ourselves next time and show it beside the field with Undo. A different correction stops it.
        </p>
        {data.suppliers.length === 0 ? (
          <EmptyState icon={Building2Icon} title="No corrections learned yet" description={`Correct the same thing on ${data.rules.learn_after} approved bills from one supplier and we'll remember it.`} />
        ) : (
          <ul className="grid gap-3">
            {data.suppliers.map((s) => (
              <li key={s.counterparty_id} aria-label={s.name} className="rounded-xl border bg-card shadow-card">
                <div className="flex flex-wrap items-center gap-2 border-b py-2 pr-2 pl-4">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.name}</span>
                  <Badge variant="outline">{s.kind === "customer" ? "Customer" : "Supplier"}</Badge>
                  {data.can_reset && <ResetButton what={{ scope: "supplier", counterparty_id: s.counterparty_id }} label="Forget all" confirm={`Forget everything we learned about ${s.name}?`} />}
                </div>
                <ul className="divide-y">
                  {s.items.map((i) => (
                    <li key={i.field} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-32 shrink-0 text-muted-foreground">{i.label}</span>
                      <span className="min-w-0 flex-1 basis-48">{i.sentence}</span>
                      {data.can_reset && <ResetButton what={{ scope: "field", counterparty_id: s.counterparty_id, field: i.field }} label="Forget" />}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="learned-recommendations" className="grid gap-3">
        <h2 id="learned-recommendations" className="text-[15px] font-semibold">
          From your decisions on recommendations
        </h2>
        <p className="text-sm text-muted-foreground">
          We show the kinds you act on higher, within the same level of importance. A minor kind you act on less than {formatPercent(data.rules.fold_below * 100)} of the time, after {data.rules.fold_after} decisions, is folded under "Less useful to you". Urgent items and changed bank details always stay at the top.
        </p>
        {data.recommendations.length === 0 ? (
          <EmptyState icon={LightbulbIcon} title="No decisions yet" description="Act on or dismiss a recommendation and we'll learn which kinds are useful to you." />
        ) : (
          <ul className="divide-y rounded-xl border bg-card shadow-card">
            {data.recommendations.map((k) => (
              <li key={k.kind} aria-label={k.label} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-44 shrink-0 font-medium">{k.label}</span>
                <span className="min-w-0 flex-1 basis-48 text-muted-foreground">{k.sentence}</span>
                <ShareBar share={k.acted_share} label={`Acted on ${formatPercent(k.acted_share * 100)}`} />
                {k.less_useful && <Badge variant="neutral">Less useful to you</Badge>}
                {data.can_reset && <ResetButton what={{ scope: "kind", kind: k.kind }} label="Reset" />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Learning never approves anything by itself. Values we fill in still go through the usual checks and approvals, and only a business owner can reset what we've learned.
      </p>
    </>
  );
}

function ShareBar({ share, label }: { share: number; label: string }) {
  return (
    <span className="flex w-28 shrink-0 items-center gap-2" title={label}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="w-9 text-right text-xs tabular text-muted-foreground">{formatPercent(share * 100)}</span>
    </span>
  );
}

/** A reset, asking first when it forgets more than one thing. */
function ResetButton({ what, label, confirm }: { what: LearningReset; label: string; confirm?: string }) {
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
  const button = (
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
