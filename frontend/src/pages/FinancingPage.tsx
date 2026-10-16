import { CircleCheckIcon, CircleIcon, FileDownIcon, InfoIcon, LandmarkIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useCurrentUser } from "@/api/auth";
import { useFinancing, useFinancingQuote } from "@/api/hooks";
import type { Financing, FinancingOption } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, HeadlineSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function FinancingPage() {
  const financing = useFinancing();
  return (
    <div className="grid gap-6">
      <PageHeader title="Financing" description="Options to cover a cash gap, compared by what they really cost. Information, not advice." />
      <QueryView
        query={financing}
        loading={
          <div className="grid gap-6" aria-busy="true">
            <HeadlineSkeleton />
            <CardsSkeleton />
          </div>
        }
        empty={
          <EmptyState
            icon={LandmarkIcon}
            title="No financing options yet"
            description="When a shortfall is forecast, or a what-if shows a gap, suitable options will be matched to its size and length here."
          />
        }
      >
        {(data) => <FinancingContent data={data} />}
      </QueryView>
    </div>
  );
}

function FinancingContent({ data }: { data: Financing }) {
  const currency = useCurrentUser().business.currency;
  const options = useMemo(
    () => [...data.options].sort((a, b) => Number(b.free) - Number(a.free) || Number(b.eligible) - Number(a.eligible)),
    [data.options],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [packOpen, setPackOpen] = useState(false);
  const selected = options.find((o) => o.id === selectedId) ?? null;

  return (
    <>
      {data.gap ? (
        <Headline
          label="Cash gap to cover"
          value={<Money minor={data.gap.amount_minor} currency={currency} />}
          note={`For about ${data.gap.days} days from ${formatDate(data.gap.starts_on, true)}`}
        />
      ) : (
        <Headline label="Cash gap to cover" value="None forecast" note={<StatusDot status="positive" label="Cash stays above your safety level for the next 90 days" showLabel />} />
      )}

      <section aria-labelledby="options-heading" className="grid gap-3">
        <h2 id="options-heading" className="text-sm font-medium">
          Options <span className="font-normal text-muted-foreground">· free options first</span>
        </h2>
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">No options match right now.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {options.map((o) => (
              <li key={o.id}>
                <OptionCard option={o} currency={currency} selected={o.id === selectedId} onSelect={() => setSelectedId(o.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && <OptionPlanner key={selected.id} option={selected} defaultAmount={data.gap?.amount_minor ?? null} currency={currency} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="readiness-heading" className="rounded-xl border bg-card shadow-card">
          <h2 id="readiness-heading" className="px-5 pt-4 text-sm font-medium">
            What a lender looks at
          </h2>
          <ul className="grid gap-3 px-5 pb-5 pt-3">
            {data.readiness.map((r) => (
              <li key={r.id} className="flex gap-2.5 text-sm">
                {r.ok ? <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Ready" /> : <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not yet" />}
                <div>
                  <p>{r.label}</p>
                  {!r.ok && r.tip && <p className="text-xs text-muted-foreground">{r.tip}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="pack-heading" className="flex flex-col rounded-xl border bg-card shadow-card">
          <div className="flex-1 px-5 pt-4">
            <h2 id="pack-heading" className="text-sm font-medium">
              Lender pack
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              A PDF of your business profile, profit and loss and unpaid invoices to share with a lender. Sharing needs approval, and nothing is ever applied for automatically.
            </p>
          </div>
          <div className="grid gap-2 px-5 pb-5 pt-4">
            <div>
              <Button variant="secondary" disabled={!data.lender_pack.available || !data.lender_pack.confirmation} onClick={() => setPackOpen(true)} aria-describedby="pack-reason">
                <FileDownIcon aria-hidden /> Share lender pack
              </Button>
            </div>
            {!data.lender_pack.available && (
              <p id="pack-reason" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="size-3.5" aria-hidden /> The pack needs at least three months of records first.
              </p>
            )}
          </div>
        </section>
      </div>

      <FocusedPanel open={packOpen} onOpenChange={setPackOpen} title="Share lender pack">
        {data.lender_pack.confirmation && (
          <div className="mx-auto max-w-xl">
            <ActionConfirmation confirmation={data.lender_pack.confirmation} onDone={() => setPackOpen(false)} />
          </div>
        )}
      </FocusedPanel>
    </>
  );
}

function OptionCard({ option, currency, selected, onSelect }: { option: FinancingOption; currency: string; selected: boolean; onSelect: () => void }) {
  return (
    <div className={cn("flex h-full flex-col rounded-xl border bg-card shadow-card", selected && "ring-2 ring-primary/50")}>
      <div className="flex-1 p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">{option.provider}</div>
            <h3 className="font-semibold">{option.product}</h3>
          </div>
          {option.free && <Badge variant="positive">Free</Badge>}
        </div>
        <p className="mt-3 text-sm">
          <Money minor={option.min_minor} currency={currency} /> to <Money minor={option.max_minor} currency={currency} />
        </p>
        <p className="text-sm text-muted-foreground">
          {option.min_months === option.max_months ? `${option.min_months} months` : `${option.min_months} to ${option.max_months} months`}
        </p>
        {option.eligibility_note && (
          <p className="mt-2 flex items-center gap-1.5 text-xs">
            <StatusDot status={option.eligible ? "positive" : "warning"} label={option.eligible ? "Likely eligible" : "May not qualify"} />
            {option.eligibility_note}
          </p>
        )}
      </div>
      <div className="border-t px-5 py-3">
        <Button variant={selected ? "default" : "secondary"} size="sm" onClick={onSelect} aria-pressed={selected}>
          {selected ? "Selected" : "See cost and effect"}
        </Button>
      </div>
    </div>
  );
}

function OptionPlanner({ option, defaultAmount, currency }: { option: FinancingOption; defaultAmount: number | null; currency: string }) {
  const step = 10_000; // £100 in pence
  const clamp = (v: number) => Math.min(option.max_minor, Math.max(option.min_minor, v));
  const [amount, setAmount] = useState(clamp(Math.ceil((defaultAmount ?? option.min_minor) / step) * step));
  const [months, setMonths] = useState(option.min_months);
  const quote = useFinancingQuote({ option_id: option.id, amount_minor: amount, months });

  return (
    <section aria-label={`Plan ${option.product}`} className="grid gap-6 rounded-xl border bg-card p-5 shadow-card lg:grid-cols-[1fr_1.4fr]">
      <div className="grid content-start gap-6">
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <Money minor={amount} currency={currency} className="font-medium" />
          </div>
          <Slider min={option.min_minor} max={option.max_minor} step={step} value={[amount]} onValueChange={([v]) => v !== undefined && setAmount(v)} aria-label="Amount" />
        </div>
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Length</span>
            <span className="font-medium tabular">{months} months</span>
          </div>
          <Slider
            min={option.min_months}
            max={option.max_months}
            step={1}
            value={[months]}
            onValueChange={([v]) => v !== undefined && setMonths(v)}
            disabled={option.min_months === option.max_months}
            aria-label="Length in months"
          />
        </div>
      </div>
      <div className="grid content-start gap-4">
        {quote.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden /> Working out the cost…
          </p>
        ) : !quote.data ? (
          <p className="text-sm text-muted-foreground">{quote.isError ? "We couldn't work out the cost. Please try again." : "Cost comparison isn't available for this option yet."}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Total cost</div>
                <div className="text-2xl font-semibold">
                  <Money minor={quote.data.total_cost_minor} currency={currency} />
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Monthly repayment</div>
                <div className="text-2xl font-semibold">
                  <Money minor={quote.data.monthly_repayment_minor} currency={currency} />
                </div>
              </div>
            </div>
            <p className="text-sm">{quote.data.forecast_effect}</p>
          </>
        )}
      </div>
    </section>
  );
}
