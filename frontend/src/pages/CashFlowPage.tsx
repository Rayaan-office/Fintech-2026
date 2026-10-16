import { CalendarPlusIcon, PlugIcon, RotateCcwIcon, TrendingUpIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { useCashFlow, useWhatIf, type WhatIf } from "@/api/hooks";
import type { CashFlow } from "@/api/types";
import { ChartCard } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { CountUp } from "@/components/CountUp";
import { HelpHint } from "@/components/HelpHint";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ChartSkeleton, HeadlineSkeleton, ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WhyHint } from "@/components/WhyHint";
import { formatDate } from "@/lib/format";
import { fractionDigits } from "@/lib/money";

export default function CashFlowPage() {
  const cash = useCashFlow();
  return (
    <div className="grid gap-6">
      <PageHeader title="Cash flow" description="What your cash is likely to do over the next 90 days." />
      <QueryView
        query={cash}
        loading={
          <div className="grid gap-6" aria-busy="true">
            <HeadlineSkeleton />
            <ChartSkeleton height={300} />
            <ListSkeleton rows={3} />
          </div>
        }
        empty={
          <EmptyState
            icon={TrendingUpIcon}
            title="No forecast yet"
            description="Connect your bank or upload a statement and we'll forecast your cash 7, 30, 60 and 90 days ahead."
            action={
              <Button asChild>
                <Link to="/connections">
                  <PlugIcon aria-hidden /> Connect your bank
                </Link>
              </Button>
            }
          />
        }
      >
        {(data) => <CashFlowContent base={data} />}
      </QueryView>
    </div>
  );
}

function CashFlowContent({ base }: { base: CashFlow }) {
  const me = useCurrentUser();
  const currency = me.business.currency;
  const [params, setParams] = useSearchParams();
  const [scenario, setScenario] = useState<WhatIf>({ planned: [], excluded_bill_ids: [] });
  const changed = scenario.planned.length > 0 || scenario.excluded_bill_ids.length > 0;
  const whatIf = useWhatIf(changed ? scenario : null);
  const data = changed && whatIf.data ? whatIf.data : base;
  const planOpen = params.get("plan") === "1";
  const setPlanOpen = (open: boolean) =>
    setParams(
      (p) => {
        if (open) p.set("plan", "1");
        else p.delete("plan");
        return p;
      },
      { replace: true },
    );

  const below = data.lowest.balance_minor < data.safety_level_minor;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Headline
          label={<HelpHint term="Lowest point">Lowest point in the next 90 days</HelpHint>}
          value={<CountUp value={data.lowest.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>}
          note={
            <span className="flex flex-wrap items-center gap-2">
              on {formatDate(data.lowest.date, true)}
              {below ? (
                <StatusDot status="warning" label="Below your safety level" showLabel />
              ) : (
                <StatusDot status="positive" label="Stays above your safety level" showLabel />
              )}
            </span>
          }
        />
        <div className="flex items-center gap-2">
          {changed && (
            <>
              <Badge variant="accent">What-if</Badge>
              <Button variant="ghost" size="sm" onClick={() => setScenario({ planned: [], excluded_bill_ids: [] })}>
                <RotateCcwIcon aria-hidden /> Reset
              </Button>
            </>
          )}
          <Button variant="secondary" onClick={() => setPlanOpen(true)}>
            <CalendarPlusIcon aria-hidden /> Plan a cost
          </Button>
        </div>
      </div>
      {changed && whatIf.data === null && (
        <p className="text-sm text-muted-foreground">What-if planning isn't available yet, so the forecast below hasn't changed.</p>
      )}

      <ChartCard
        title={
          <span className="flex items-center gap-3">
            Forecast
            <span className="text-xs font-normal text-muted-foreground">
              <HelpHint term="Best to worst">Shaded: best to worst</HelpHint>
            </span>
          </span>
        }
        summary={`Cash forecast for 90 days. The lowest point is on ${formatDate(data.lowest.date, true)}. Bills are shown as markers.`}
        table={{
          columns: [
            { key: "date", label: "Date" },
            { key: "expected", label: "Expected", numeric: true },
            { key: "best", label: "Best", numeric: true },
            { key: "worst", label: "Worst", numeric: true },
          ],
          rows: data.series.map((p) => ({
            id: p.date,
            date: formatDate(p.date, true),
            expected: <Money minor={p.expected_minor} currency={currency} />,
            best: <Money minor={p.best_minor} currency={currency} />,
            worst: <Money minor={p.worst_minor} currency={currency} />,
          })),
        }}
      >
        <CashAreaChart
          series={data.series}
          currency={currency}
          height={300}
          safetyLevelMinor={data.safety_level_minor}
          lowest={data.lowest}
          markers={data.bills.filter((b) => !scenario.excluded_bill_ids.includes(b.id))}
        />
      </ChartCard>

      <section aria-labelledby="warnings-heading" className="grid gap-3">
        <h2 id="warnings-heading" className="text-sm font-medium">
          Warnings
        </h2>
        {data.warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No warnings. Your cash stays above your safety level.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card shadow-card">
            {data.warnings.map((w) => (
              <li key={w.id} className="flex gap-3 px-4 py-3.5">
                <TriangleAlertIcon className={w.severity === "urgent" ? "size-4 shrink-0 text-danger" : "size-4 shrink-0 text-warning"} aria-label={w.severity === "urgent" ? "Urgent" : "Needs attention"} />
                <div className="grid gap-1">
                  <p className="text-sm">{w.sentence}</p>
                  <WhyHint why={w.why} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {base.bills.length > 0 && (
        <section aria-labelledby="bills-heading" className="grid gap-3">
          <h2 id="bills-heading" className="text-sm font-medium">
            Upcoming bills <span className="font-normal text-muted-foreground">· switch one off to see the forecast without it</span>
          </h2>
          <ul className="divide-y rounded-xl border bg-card shadow-card">
            {base.bills.map((b) => {
              const included = !scenario.excluded_bill_ids.includes(b.id);
              return (
                <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-16 shrink-0 text-sm text-muted-foreground">{formatDate(b.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{b.label}</span>
                  <Money minor={b.amount_minor} currency={currency} direction="out" className="text-sm" />
                  <Switch
                    checked={included}
                    aria-label={`Include ${b.label} in the forecast`}
                    onCheckedChange={(on) =>
                      setScenario((s) => ({
                        ...s,
                        excluded_bill_ids: on ? s.excluded_bill_ids.filter((id) => id !== b.id) : [...s.excluded_bill_ids, b.id],
                      }))
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <SidePanel open={planOpen} onOpenChange={setPlanOpen} title="Plan a cost" description="Add a planned cost, such as a new van, and see the new lowest point.">
        <PlanForm
          currency={currency}
          onAdd={(p) => {
            setScenario((s) => ({ ...s, planned: [...s.planned, p] }));
            setPlanOpen(false);
          }}
        />
        {scenario.planned.length > 0 && (
          <ul className="mt-6 grid gap-2 text-sm">
            {scenario.planned.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <span>
                  {p.label} · {formatDate(p.date)}
                </span>
                <Money minor={p.amount_minor} currency={currency} direction="out" />
              </li>
            ))}
          </ul>
        )}
      </SidePanel>
    </>
  );
}

function PlanForm({ currency, onAdd }: { currency: string; onAdd: (p: WhatIf["planned"][number]) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const parsed = Number(amount.replace(/[,£$€\s]/g, ""));
  const valid = label.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && date !== "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd({ label: label.trim(), amount_minor: Math.round(parsed * 10 ** fractionDigits(currency)), date });
    setLabel("");
    setAmount("");
    setDate("");
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="plan-label">What is it?</Label>
        <Input id="plan-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New van" maxLength={80} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="plan-amount">Amount</Label>
        <Input id="plan-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12,000" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="plan-date">When</Label>
        <Input id="plan-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Button type="submit" disabled={!valid}>
        Add to forecast
      </Button>
      {!valid && <p className="text-xs text-muted-foreground">Fill in what it is, the amount and the date to add it.</p>}
    </form>
  );
}
