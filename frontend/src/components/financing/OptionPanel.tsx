import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/api/client";
import { useCashFlow, useFinancingQuote } from "@/api/hooks";
import type { Financing, FinancingOption, QuoteResult } from "@/api/types";
import { ChartCard } from "@/components/ChartCard";
import { ForecastEffectChart } from "@/components/charts";
import { Money } from "@/components/Money";
import { FormError } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** One option in detail: what it is, sliders for amount and length, the cost, and what it does to the forecast. */
export function OptionPlanner({ option: o, need, safetyLevelMinor, currency }: { option: FinancingOption; need: Financing["need"]; safetyLevelMinor: number; currency: string }) {
  const top = Math.max(o.limit_minor, o.min_minor);
  const step = top - o.min_minor >= 1_000_00 ? 100_00 : 10_00;
  const clamp = (v: number) => Math.min(top, Math.max(o.min_minor, v));
  const [amount, setAmount] = useState(() => clamp(o.quote?.amount_minor ?? need.amount_minor ?? o.min_minor));
  const [months, setMonths] = useState(() => Math.min(o.max_months, Math.max(o.min_months, o.quote?.months ?? need.months ?? o.min_months)));
  const input = useDebounced({ option_id: o.id, amount_minor: amount, months });
  const quote = useFinancingQuote(input);
  const base = useCashFlow();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-2">
        {o.free && <Badge variant="positive" className="w-fit">Free</Badge>}
        <p className="text-sm text-muted-foreground">{o.about}</p>
      </div>
      {!o.eligible && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft/50 p-3 text-sm">
          <p className="font-medium">You can't use this yet</p>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {o.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-5">
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <Money minor={amount} currency={currency} className="font-medium" />
          </div>
          <Slider min={o.min_minor} max={top} step={step} value={[amount]} onValueChange={([v]) => v !== undefined && setAmount(v)} disabled={top === o.min_minor} aria-label="Amount" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <Money minor={o.min_minor} currency={currency} />
            <span>
              up to <Money minor={top} currency={currency} />
            </span>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Length</span>
            <span className="font-medium tabular">{months === 1 ? "1 month" : `${months} months`}</span>
          </div>
          <Slider
            min={o.min_months}
            max={o.max_months}
            step={1}
            value={[months]}
            onValueChange={([v]) => v !== undefined && setMonths(v)}
            disabled={o.min_months === o.max_months}
            aria-label="Length in months"
          />
        </div>
      </div>
      <div aria-live="polite" className="grid gap-4">
        {quote.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden /> Working out the cost…
          </p>
        ) : quote.isError ? (
          <FormError message={errorMessage(quote.error)} />
        ) : quote.data ? (
          <QuoteView q={quote.data} without={base.data?.series} safetyLevelMinor={safetyLevelMinor} currency={currency} stale={quote.isFetching} />
        ) : (
          <p className="text-sm text-muted-foreground">We couldn't cost this option.</p>
        )}
      </div>
    </div>
  );
}

function QuoteView({ q, without, safetyLevelMinor, currency, stale }: { q: QuoteResult; without?: { date: string; expected_minor: number }[]; safetyLevelMinor: number; currency: string; stale: boolean }) {
  const weekly = q.series.filter((_, i) => i % 7 === 0);
  const before = new Map((without ?? []).map((p) => [p.date, p.expected_minor]));
  return (
    <div className={cn("grid gap-5 transition-opacity", stale && "opacity-60")}>
      <dl className="grid grid-cols-2 gap-4 border-y py-4">
        <div>
          <dt className="text-[13px] text-muted-foreground">Total cost</dt>
          <dd className="mt-0.5 text-2xl font-semibold tracking-tight">
            <Money minor={q.total_cost_minor} currency={currency} />
          </dd>
          {q.cost_range_minor[0] !== q.cost_range_minor[1] && (
            <dd className="text-xs text-muted-foreground">
              <Money minor={q.cost_range_minor[0]} currency={currency} /> to <Money minor={q.cost_range_minor[1]} currency={currency} />
            </dd>
          )}
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">A month</dt>
          <dd className="mt-0.5 text-2xl font-semibold tracking-tight">{q.monthly_repayment_minor ? <Money minor={q.monthly_repayment_minor} currency={currency} /> : "Nothing"}</dd>
          {q.yearly_cost_pct !== null && <dd className="text-xs text-muted-foreground">About {q.yearly_cost_pct}% a year</dd>}
        </div>
        {q.fee_minor > 0 && (
          <div className="col-span-2 text-xs text-muted-foreground">
            Includes a fee of <Money minor={q.fee_minor} currency={currency} />.
          </div>
        )}
      </dl>
      <p className="flex items-start gap-2 text-sm">
        <StatusDot status={q.closes_gap ? "positive" : "warning"} label={q.closes_gap ? "Closes the gap" : "Doesn't close the gap"} className="mt-1.5" />
        {q.forecast_effect}
      </p>
      <ChartCard
        title="Cash with this option"
        summary={q.forecast_effect}
        className="shadow-none"
        table={{
          columns: [
            { key: "date", label: "Week of" },
            { key: "with", label: "With this", numeric: true },
            { key: "without", label: "Without", numeric: true },
          ],
          rows: weekly.map((p) => ({
            id: p.date,
            date: formatDate(p.date, true),
            with: <Money minor={p.expected_minor} currency={currency} />,
            without: before.has(p.date) ? <Money minor={before.get(p.date)!} currency={currency} /> : "–",
          })),
        }}
      >
        <ForecastEffectChart series={q.series} without={without} safetyLevelMinor={safetyLevelMinor} currency={currency} height={200} />
      </ChartCard>
    </div>
  );
}
