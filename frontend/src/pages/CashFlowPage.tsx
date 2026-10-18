import { CalendarPlusIcon, PlugIcon, TrendingUpIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useCashFlow, useWhatIf } from "@/api/hooks";
import type { CashFlow, PlannedCost, WhatIfInput } from "@/api/types";
import { BillStrip } from "@/components/cashflow/BillStrip";
import { ForecastSurface } from "@/components/cashflow/ForecastSurface";
import { MoneyOut } from "@/components/cashflow/MoneyOut";
import { KeptPlans, PlanForm, TriedPlans } from "@/components/cashflow/PlanCost";
import { Warnings } from "@/components/cashflow/Warnings";
import { WhyCashChanged } from "@/components/cashflow/WhyCashChanged";
import { CountUp } from "@/components/CountUp";
import { HelpHint } from "@/components/HelpHint";
import { StatStrip } from "@/components/kit";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ChartSkeleton, HeadlineSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addDays, formatDate } from "@/lib/format";

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
  const [, setParams] = useSearchParams();
  const ready = cash.data != null && !isBlank(cash.data);
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
    <div className="grid grid-cols-1 gap-8">
      <PageHeader
        title="Cash flow"
        actions={
          ready && (
            <Button
              variant="secondary"
              onClick={() =>
                setParams(
                  (p) => {
                    p.set("plan", "1");
                    return p;
                  },
                  { replace: true },
                )
              }
            >
              <CalendarPlusIcon aria-hidden /> Plan a cost
            </Button>
          )
        }
      />
      <QueryView
        query={cash}
        loading={
          <div className="grid gap-8" aria-busy="true">
            <HeadlineSkeleton />
            <ChartSkeleton height={340} />
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

  return (
    <>
      <div className="-mt-4 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <Headline
          label={<HelpHint term="Lowest point">Lowest point in the next 90 days</HelpHint>}
          value={<CountUp value={data.lowest.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>}
          note={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              on {formatDate(data.lowest.date, true)}
              {below ? (
                <StatusDot status="warning" label="Below your safety level" showLabel />
              ) : (
                <StatusDot status="positive" label="Stays above your safety level" showLabel />
              )}
            </span>
          }
        />
        <StatStrip
          className="w-full lg:w-auto lg:min-w-[30rem] lg:flex-1 lg:max-w-2xl"
          items={(["7", "30", "60", "90"] as const).map((n) => ({
            label: `In ${n} days`,
            value: (
              <>
                <Money minor={data.horizons[n]} currency={currency} />
                {data.horizons[n] < data.safety_level_minor && <span className="sr-only"> (below your safety level)</span>}
              </>
            ),
            tone: data.horizons[n] < data.safety_level_minor ? "warning" : "default",
          }))}
        />
      </div>

      <div className="grid gap-3">
        <ForecastSurface
          data={data}
          base={base}
          currency={currency}
          highlight={dragging}
          whatIf={{
            on: changed,
            data: whatIf.data,
            updating,
            error: whatIf.isError ? errorMessage(whatIf.error) : null,
            onReset: () => setScenario(NO_CHANGES),
            excluded: scenario.excluded,
          }}
          strip={
            <BillStrip
              bills={base.bills.filter((b) => b.movable && !scenario.excluded.includes(b.id))}
              moved={scenario.moved}
              today={base.today}
              end={end}
              currency={currency}
              onMove={move}
              onDragging={setDragging}
            />
          }
        />
        <Warnings warnings={data.warnings} />
      </div>

      <Tabs defaultValue="out" className="grid gap-4">
        <TabsList aria-label="More about your cash flow" className="justify-self-start">
          <TabsTrigger value="out">Money going out</TabsTrigger>
          <TabsTrigger value="why">Why cash changed</TabsTrigger>
        </TabsList>
        <TabsContent value="out">
          <MoneyOut
            bills={base.bills}
            excluded={scenario.excluded}
            moved={scenario.moved}
            currency={currency}
            onToggle={(id, on) => setScenario((s) => ({ ...s, excluded: on ? s.excluded.filter((x) => x !== id) : [...s.excluded, id] }))}
            onPutBack={(id) => move(id, null)}
          />
        </TabsContent>
        <TabsContent value="why">
          <WhyCashChanged currency={currency} />
        </TabsContent>
      </Tabs>

      <SidePanel open={planOpen} onOpenChange={setPlanOpen} title="Plan a cost" description="Add a cost you expect, such as a new van, and see what it does to your lowest point.">
        <PlanForm currency={currency} today={base.today} end={end} onAdd={(p: PlannedCost) => setScenario((s) => ({ ...s, planned: [...s.planned, p] }))} />
        <TriedPlans plans={scenario.planned} currency={currency} onRemove={(i) => setScenario((s) => ({ ...s, planned: s.planned.filter((_, j) => j !== i) }))} />
        <KeptPlans currency={currency} />
      </SidePanel>
    </>
  );
}
