import { CalendarPlusIcon, InfoIcon, Loader2Icon, PlugIcon, RotateCcwIcon, TrendingUpIcon, TriangleAlertIcon, Undo2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useAddPlan, useCashFlow, usePlannedItems, useRemovePlan, useWhatIf, useWhyCashChanged } from "@/api/hooks";
import type { CashFlow, CashWarning, ForecastBill, PlannedCost, PlanRepeat, WhatIfInput, WhyPeriod } from "@/api/types";
import { Worded } from "@/components/AiText";
import { ChartCard } from "@/components/ChartCard";
import { CASH_CHART_INSET, CashAreaChart } from "@/components/charts";
import { CountUp } from "@/components/CountUp";
import { HelpHint } from "@/components/HelpHint";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ChartSkeleton, HeadlineSkeleton, ListSkeleton } from "@/components/skeletons";
import { EmptyState, ErrorState, FormError } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WhyHint } from "@/components/WhyHint";
import { addDays, daysBetween, formatDate } from "@/lib/format";
import { fractionDigits } from "@/lib/money";
import { cn } from "@/lib/utils";

const selectClass = "h-10 w-full rounded-lg border border-input bg-card px-3 text-base shadow-card sm:text-sm";
const MAX_MINOR = 100_000_000_00; // the server's limit: anything larger is a typing mistake

/** What the person is trying out. Nothing here is saved, and real records never change. */
type Scenario = { planned: PlannedCost[]; excluded: string[]; moved: Record<string, string> };
const NO_CHANGES: Scenario = { planned: [], excluded: [], moved: {} };

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A forecast with nothing in it: no balance and nothing coming in or going out. */
const isBlank = (cf: CashFlow) => cf.balance_minor === 0 && cf.items.length === 0;

export default function CashFlowPage() {
  const cash = useCashFlow();
  const noForecast = (
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
  );
  return (
    <div className="grid grid-cols-1 gap-6">
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
        empty={noForecast}
      >
        {(data) => (isBlank(data) ? noForecast : <CashFlowContent base={data} />)}
      </QueryView>
    </div>
  );
}

function CashFlowContent({ base }: { base: CashFlow }) {
  const currency = useCurrentUser().business.currency;
  const [params, setParams] = useSearchParams();
  const [scenario, setScenario] = useState<Scenario>(NO_CHANGES);
  const [dragging, setDragging] = useState<string | null>(null);
  const changed = scenario.planned.length > 0 || scenario.excluded.length > 0 || Object.keys(scenario.moved).length > 0;
  const input: WhatIfInput | null = useMemo(
    () =>
      changed
        ? {
            planned: scenario.planned,
            excluded_bill_ids: scenario.excluded,
            moved_bills: Object.entries(scenario.moved).map(([id, date]) => ({ id, date })),
          }
        : null,
    [changed, scenario],
  );
  // Arrow keys move a bill a day at a time: ask once the person pauses
  const asked = useDebounced(input);
  const whatIf = useWhatIf(asked);
  const data = changed && whatIf.data ? whatIf.data : base;
  const updating = changed && (whatIf.isFetching || asked !== input);

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

  const move = (id: string, date: string | null) =>
    setScenario((s) => {
      const moved = { ...s.moved };
      if (date === null || date === base.bills.find((b) => b.id === id)?.date) delete moved[id];
      else moved[id] = date;
      return { ...s, moved };
    });

  const below = data.lowest.balance_minor < data.safety_level_minor;
  const end = base.series.at(-1)?.date ?? addDays(base.today, 90);
  const markers = data.bills.filter((b) => !scenario.excluded.includes(b.id));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Headline
          label={<HelpHint term="Lowest point">Lowest point in the next 90 days</HelpHint>}
          value={<CountUp value={data.lowest.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>}
          note={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              on {formatDate(data.lowest.date, true)}
              {below ? (
                <StatusDot status="warning" label="Below your safety level" showLabel />
              ) : (
                <StatusDot status="positive" label="Stays above your safety level" showLabel />
              )}
            </span>
          }
        />
        <Button variant="secondary" onClick={() => setPlanOpen(true)}>
          <CalendarPlusIcon aria-hidden /> Plan a cost
        </Button>
      </div>

      {changed && (
        <WhatIfBar
          data={whatIf.data}
          currency={currency}
          updating={updating}
          error={whatIf.isError ? errorMessage(whatIf.error) : null}
          onReset={() => setScenario(NO_CHANGES)}
        />
      )}

      <Horizons data={data} currency={currency} />

      <ChartCard
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
          markers={markers}
          before={changed && whatIf.data ? base.series : undefined}
          highlight={dragging}
        />
      </ChartCard>
      <BillStrip
        bills={base.bills.filter((b) => b.movable && !scenario.excluded.includes(b.id))}
        moved={scenario.moved}
        today={base.today}
        end={end}
        currency={currency}
        onMove={move}
        onDragging={setDragging}
      />

      <Warnings warnings={data.warnings} />

      <Bills
        bills={base.bills}
        scenario={scenario}
        currency={currency}
        onToggle={(id, on) =>
          setScenario((s) => ({ ...s, excluded: on ? s.excluded.filter((x) => x !== id) : [...s.excluded, id] }))
        }
        onPutBack={(id) => move(id, null)}
      />

      <WhyCashChanged currency={currency} />

      <SafetyLevel data={data} currency={currency} />

      <SidePanel open={planOpen} onOpenChange={setPlanOpen} title="Plan a cost" description="Add a cost you expect, such as a new van, and see what it does to your lowest point.">
        <PlanForm
          currency={currency}
          today={base.today}
          end={end}
          onAdd={(p) => setScenario((s) => ({ ...s, planned: [...s.planned, p] }))}
        />
        <TriedPlans
          plans={scenario.planned}
          currency={currency}
          onRemove={(i) => setScenario((s) => ({ ...s, planned: s.planned.filter((_, j) => j !== i) }))}
        />
        <KeptPlans currency={currency} />
      </SidePanel>
    </>
  );
}

function WhatIfBar({
  data,
  currency,
  updating,
  error,
  onReset,
}: {
  data: ReturnType<typeof useWhatIf>["data"];
  currency: string;
  updating: boolean;
  error: string | null;
  onReset: () => void;
}) {
  const w = data?.what_if;
  const diff = w ? w.lowest_after.balance_minor - w.lowest_before.balance_minor : 0;
  return (
    <div className="grid gap-3">
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-primary-soft/50 px-4 py-3">
        <Badge variant="accent">What-if</Badge>
        <p className="min-w-0 flex-1 text-sm">
          {w ? (
            <>
              Lowest point <Money minor={w.lowest_after.balance_minor} currency={currency} /> on {formatDate(w.lowest_after.date)}, instead of{" "}
              <Money minor={w.lowest_before.balance_minor} currency={currency} />
              {diff !== 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  (<Money minor={Math.abs(diff)} currency={currency} /> {diff > 0 ? "higher" : "lower"})
                </span>
              )}
              .{" "}
              <span className="text-muted-foreground">Nothing is saved and your records don't change.</span>
            </>
          ) : (
            "Working out the new forecast…"
          )}
        </p>
        {updating && <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-label="Updating" />}
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcwIcon aria-hidden /> Reset
        </Button>
      </div>
      {error && <ErrorState message={error} />}
    </div>
  );
}

function Horizons({ data, currency }: { data: CashFlow; currency: string }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-4">
      {(["7", "30", "60", "90"] as const).map((n) => (
        <div key={n} className="bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">In {n} days</dt>
          <dd className="mt-0.5 text-base font-semibold tabular">
            <Money minor={data.horizons[n]} currency={currency} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Drag a bill ────────────────────────────────────────────────────────────

const LANE_GAP = 0.16; // chips closer than this share of the strip go on another row

/**
 * Unpaid bills on a strip lined up with the chart's days. Drag one (or use the arrow keys)
 * to see what paying it on another day does. Only the what-if changes.
 */
function BillStrip({
  bills,
  moved,
  today,
  end,
  currency,
  onMove,
  onDragging,
}: {
  bills: ForecastBill[];
  moved: Record<string, string>;
  today: string;
  end: string;
  currency: string;
  onMove: (id: string, date: string) => void;
  onDragging: (id: string | null) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ id: string; date: string } | null>(null);
  const span = Math.max(1, daysBetween(today, end));
  if (bills.length === 0) return null;

  const committed = (b: ForecastBill) => moved[b.id] ?? b.date;
  const dateOf = (b: ForecastBill) => (preview?.id === b.id ? preview.date : committed(b));
  const clamp = (d: number) => Math.min(span, Math.max(1, d));
  const placed = bills
    .map((b) => ({ bill: b, date: dateOf(b), at: daysBetween(today, dateOf(b)) / span }))
    .sort((a, b) => a.at - b.at);
  const lanes: number[] = [];
  const lane = new Map<string, number>();
  for (const p of placed) {
    let i = lanes.findIndex((last) => p.at - last >= LANE_GAP);
    if (i === -1) i = lanes.length;
    lanes[i] = p.at;
    lane.set(p.bill.id, i);
  }

  const dayAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 1;
    return clamp(Math.round(((clientX - r.left) / r.width) * span));
  };

  const onPointerDown = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPreview({ id: b.id, date: dateOf(b) });
    onDragging(b.id);
  };
  const onPointerMove = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    if (preview?.id !== b.id) return;
    setPreview({ id: b.id, date: addDays(today, dayAt(e.clientX)) });
  };
  const onPointerUp = (b: ForecastBill) => () => {
    if (preview?.id === b.id && preview.date !== committed(b)) onMove(b.id, preview.date);
    setPreview(null);
    onDragging(null);
  };
  const onKeyDown = (b: ForecastBill) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 7, PageDown: -7 };
    const now = daysBetween(today, committed(b));
    const next = e.key === "Home" ? 1 : e.key === "End" ? span : e.key in steps ? clamp(now + steps[e.key]!) : null;
    if (next === null) return;
    e.preventDefault();
    onMove(b.id, addDays(today, next));
  };

  return (
    <section aria-labelledby="move-heading" className="-mt-3 rounded-xl border bg-card px-2 pb-3 pt-3 shadow-card sm:px-3">
      <h2 id="move-heading" className="px-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Move a bill</span> · drag one to another day, or use the arrow keys, to see the new forecast
      </h2>
      <div className="mt-2" style={{ paddingLeft: CASH_CHART_INSET.left, paddingRight: CASH_CHART_INSET.right }}>
        <div ref={track} className="relative border-t border-dashed" style={{ height: lanes.length * 30 + 6 }}>
          {placed.map(({ bill, date, at }) => {
            const isMoved = moved[bill.id] !== undefined && moved[bill.id] !== bill.date;
            const days = daysBetween(today, date);
            return (
              <button
                key={bill.id}
                type="button"
                role="slider"
                aria-label={`Move ${bill.label}`}
                aria-valuemin={1}
                aria-valuemax={span}
                aria-valuenow={days}
                aria-valuetext={formatDate(date, true)}
                onPointerDown={onPointerDown(bill)}
                onPointerMove={onPointerMove(bill)}
                onPointerUp={onPointerUp(bill)}
                onPointerCancel={() => {
                  setPreview(null);
                  onDragging(null);
                }}
                onKeyDown={onKeyDown(bill)}
                onFocus={() => onDragging(bill.id)}
                onBlur={() => onDragging(null)}
                title={`${bill.label}, ${formatDate(date)}`}
                className={cn(
                  "absolute flex max-w-[9.5rem] cursor-grab touch-none select-none items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs shadow-card active:cursor-grabbing",
                  isMoved && "border-primary/40 bg-primary-soft text-primary",
                  preview?.id === bill.id && "z-10 ring-2 ring-ring",
                )}
                style={{ left: `${at * 100}%`, top: 6 + (lane.get(bill.id) ?? 0) * 30, transform: `translateX(-${at * 100}%)` }}
              >
                <span className="truncate">{formatDate(date)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="min-w-0 truncate">{bill.label.replace(/ bill.*$/, "")}</span>
                <Money minor={bill.amount_minor} currency={currency} className="sr-only" />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Warnings, bills and why cash changed ───────────────────────────────────

function Warnings({ warnings }: { warnings: CashWarning[] }) {
  const can = useCan();
  return (
    <section aria-labelledby="warnings-heading" className="grid gap-3">
      <h2 id="warnings-heading" className="text-sm font-medium">
        Warnings
      </h2>
      {warnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No warnings. Your cash stays above your safety level, even if customers pay late.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-card">
          {warnings.map((w) => (
            <li key={w.id} className="flex gap-3 px-4 py-3.5">
              {w.severity === "info" ? (
                <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Worth watching" />
              ) : (
                <TriangleAlertIcon
                  className={cn("mt-0.5 size-4 shrink-0", w.severity === "urgent" ? "text-danger" : "text-warning")}
                  aria-label={w.severity === "urgent" ? "Urgent" : "Needs attention"}
                />
              )}
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="text-sm">{w.sentence}</p>
                <WhyHint why={w.why} />
              </div>
              {w.grade !== "watch" && can("use_financing") && (
                <Button asChild variant="link" size="sm" className="shrink-0 self-start">
                  <Link to="/financing">Ways to cover it</Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Bills({
  bills,
  scenario,
  currency,
  onToggle,
  onPutBack,
}: {
  bills: ForecastBill[];
  scenario: Scenario;
  currency: string;
  onToggle: (id: string, on: boolean) => void;
  onPutBack: (id: string) => void;
}) {
  if (bills.length === 0) return null;
  return (
    <section aria-labelledby="bills-heading" className="grid gap-3">
      <h2 id="bills-heading" className="text-sm font-medium">
        Money going out <span className="font-normal text-muted-foreground">· switch one off to see the forecast without it</span>
      </h2>
      <ul className="max-h-[28rem] divide-y overflow-y-auto rounded-xl border bg-card shadow-card">
        {bills.map((b) => {
          const included = !scenario.excluded.includes(b.id);
          const movedTo = scenario.moved[b.id];
          return (
            <li key={b.id} className={cn("flex items-center gap-3 px-4 py-3", !included && "text-muted-foreground")}>
              <span className="w-14 shrink-0 text-sm text-muted-foreground">{formatDate(movedTo ?? b.date)}</span>
              <span className="grid min-w-0 flex-1">
                <span className={cn("truncate text-sm", !included && "line-through")}>{b.label}</span>
                {movedTo && (
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-primary">
                    Moved from {formatDate(b.date)}
                    <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => onPutBack(b.id)}>
                      <Undo2Icon className="size-3" aria-hidden /> Put back
                    </button>
                  </span>
                )}
              </span>
              <Money minor={b.amount_minor} currency={currency} direction="out" className="text-sm" />
              <Switch checked={included} aria-label={`Include ${b.label} in the forecast`} onCheckedChange={(on) => onToggle(b.id, on)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const PERIODS: Record<WhyPeriod, string> = { month: "This month", "30d": "Last 30 days" };

function WhyCashChanged({ currency }: { currency: string }) {
  const [period, setPeriod] = useState<WhyPeriod>("month");
  const why = useWhyCashChanged(period);
  return (
    <section aria-labelledby="why-heading" className="grid gap-3 rounded-xl border bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="why-heading" className="text-sm font-medium">
          Why cash changed
        </h2>
        <Tabs value={period} onValueChange={(v) => setPeriod(v as WhyPeriod)}>
          <TabsList className="h-8">
            {(Object.keys(PERIODS) as WhyPeriod[]).map((p) => (
              <TabsTrigger key={p} value={p} className="h-6 px-2 text-xs">
                {PERIODS[p]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <QueryView query={why} loading={<p className="text-sm text-muted-foreground">Looking at what moved…</p>} empty={null}>
        {(w) => (
          <div className={cn("grid gap-4", why.isFetching && why.isPlaceholderData && "opacity-60")}>
            <p className="text-xs text-muted-foreground">
              {formatDate(w.this_period.from)} to {formatDate(w.this_period.to)}, compared with {formatDate(w.last_period.from)} to{" "}
              {formatDate(w.last_period.to)}
            </p>
            <Worded wording={w.explanation} className="max-w-3xl" />
            {w.reasons.length > 0 && (
              <ul className="grid gap-2" aria-label="Reasons, largest first">
                {w.reasons.slice(0, 5).map((r) => (
                  <li key={r.group} className="flex items-baseline justify-between gap-3 border-t pt-2 text-sm">
                    <span className="min-w-0">
                      {r.label}
                      {r.items.length > 0 && (
                        <span className="block truncate text-xs text-muted-foreground">{r.items.map((i) => i.label).join(", ")}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <Money minor={Math.abs(r.change_minor)} currency={currency} direction={r.change_minor > 0 ? "in" : "out"} />
                      <span className="block text-xs text-muted-foreground">{r.change_minor > 0 ? "more cash" : "less cash"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </QueryView>
    </section>
  );
}

function SafetyLevel({ data, currency }: { data: CashFlow; currency: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      <HelpHint term="Safety level" />: <Money minor={data.safety_level_minor} currency={currency} className="text-foreground" /> · {data.safety_level_why}
      {data.left_out.length > 0 && <> · Not in the forecast: {data.left_out.map((l) => l.label).join(", ")}</>}
    </p>
  );
}

// ── Plan a cost ────────────────────────────────────────────────────────────

const REPEATS: Record<PlanRepeat, string> = { none: "Just once", weekly: "Every week", monthly: "Every month" };

function PlanForm({ currency, today, end, onAdd }: { currency: string; today: string; end: string; onAdd: (p: PlannedCost) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [repeat, setRepeat] = useState<PlanRepeat>("none");
  const parsed = Number(amount.replace(/[,£$€\s]/g, ""));
  const minor = Number.isFinite(parsed) ? Math.round(parsed * 10 ** fractionDigits(currency)) : NaN;
  const first = addDays(today, 1);
  const last = addDays(today, 365);
  const dateOk = date !== "" && date >= first && date <= last;
  const valid = label.trim() !== "" && minor > 0 && minor <= MAX_MINOR && dateOk;

  const problem =
    amount !== "" && !(minor > 0)
      ? "Enter the amount as a number, such as 12,000."
      : minor > MAX_MINOR
        ? "That amount looks too large. Check the number."
        : date !== "" && !dateOk
          ? `Pick a date between ${formatDate(first, true)} and ${formatDate(last, true)}.`
          : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd({ label: label.trim(), amount_minor: minor, date, repeat, direction: "out" });
    setLabel("");
    setAmount("");
    setDate("");
    setRepeat("none");
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="plan-label">What is it?</Label>
        <Input id="plan-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New van" maxLength={120} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="plan-amount">Amount</Label>
        <Input id="plan-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12,000" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="plan-date">When</Label>
          <Input id="plan-date" type="date" min={first} max={last} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="plan-repeat">How often</Label>
          <select id="plan-repeat" className={selectClass} value={repeat} onChange={(e) => setRepeat(e.target.value as PlanRepeat)}>
            {(Object.keys(REPEATS) as PlanRepeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEATS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {dateOk && date > end && <p className="text-xs text-muted-foreground">That's after the 90 days we forecast, so the chart won't change{repeat === "none" ? "" : " until it repeats inside them"}.</p>}
      <FormError message={problem} />
      <Button type="submit" disabled={!valid}>
        Try it in the forecast
      </Button>
      {!valid && !problem && <p className="text-xs text-muted-foreground">Fill in what it is, the amount and the date to try it.</p>}
    </form>
  );
}

function TriedPlans({ plans, currency, onRemove }: { plans: PlannedCost[]; currency: string; onRemove: (i: number) => void }) {
  const can = useCan();
  const add = useAddPlan();
  if (plans.length === 0) return null;
  return (
    <section aria-labelledby="tried-heading" className="mt-6 grid gap-2">
      <h3 id="tried-heading" className="text-sm font-medium">
        Trying out <span className="font-normal text-muted-foreground">· only you see these</span>
      </h3>
      <ul className="grid gap-2 text-sm">
        {plans.map((p, i) => (
          <li key={`${p.label}-${p.date}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1">
              {p.label} · {formatDate(p.date)}
              {p.repeat && p.repeat !== "none" && <span className="text-muted-foreground"> · {REPEATS[p.repeat].toLowerCase()}</span>}
            </span>
            <Money minor={p.amount_minor} currency={currency} direction="out" />
            {can("use_financing") && (
              <Button
                size="sm"
                variant="secondary"
                disabled={add.isPending}
                onClick={() =>
                  add.mutate(p, {
                    onSuccess: () => {
                      onRemove(i);
                      toast(`${p.label} is now in the forecast for everyone in the business.`);
                    },
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              >
                Keep in forecast
              </Button>
            )}
            <Button size="icon" variant="ghost" className="size-8" aria-label={`Stop trying ${p.label}`} onClick={() => onRemove(i)}>
              <XIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeptPlans({ currency }: { currency: string }) {
  const can = useCan();
  const kept = usePlannedItems();
  const remove = useRemovePlan();
  const items = kept.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="kept-heading" className="mt-6 grid gap-2">
      <h3 id="kept-heading" className="text-sm font-medium">
        Kept in the forecast
      </h3>
      <ul className="grid gap-2 text-sm">
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1">
              {p.label} · {formatDate(p.date)}
              {p.repeat !== "none" && <span className="text-muted-foreground"> · {REPEATS[p.repeat].toLowerCase()}</span>}
            </span>
            <Money minor={p.amount_minor} currency={currency} direction={p.direction === "in" ? "in" : "out"} />
            {can("use_financing") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.id, { onSuccess: () => toast(`Removed ${p.label} from the forecast.`), onError: (err) => toast.error(errorMessage(err)) })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
