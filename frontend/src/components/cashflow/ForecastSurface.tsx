import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CashFlow, WhatIfResult } from "@/api/types";
import { DataTable } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { HelpHint } from "@/components/HelpHint";
import { InfoPopover, Surface } from "@/components/kit";
import { Money } from "@/components/Money";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { LegendKey, ViewToggle, type ChartView } from "./ViewToggle";

/**
 * The one chart on the page: the 90-day forecast with its legend, the what-if result when
 * something is being tried, and (below it, passed in) the strip of bills to drag.
 */
export function ForecastSurface({
  data,
  base,
  currency,
  whatIf,
  highlight,
  strip,
}: {
  data: CashFlow;
  base: CashFlow;
  currency: string;
  whatIf: { on: boolean; data: WhatIfResult | undefined; updating: boolean; error: string | null; onReset: () => void } & { excluded: string[] };
  highlight: string | null;
  strip: ReactNode;
}) {
  const [view, setView] = useState<ChartView>("graph");
  const markers = data.bills.filter((b) => !whatIf.excluded.includes(b.id));
  const summary = `Cash forecast for 90 days. The lowest point is on ${formatDate(data.lowest.date, true)}. Bills are shown as markers.`;
  return (
    <Surface className="overflow-hidden">
      {whatIf.on && <WhatIfBar data={whatIf.data} currency={currency} updating={whatIf.updating} onReset={whatIf.onReset} />}
      {whatIf.on && whatIf.error && <ErrorState message={whatIf.error} className="m-4" />}
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Forecast</h2>
          <LegendKey swatch="line">Expected</LegendKey>
          <LegendKey swatch="band">
            <HelpHint term="Best to worst" />
          </LegendKey>
          <LegendKey swatch="safety">
            Safety level <Money minor={data.safety_level_minor} currency={currency} className="text-foreground" />
            <InfoPopover label="About the safety level" title="Safety level" className="-ml-1 size-5">
              <p>{data.safety_level_why}.</p>
              {data.left_out.length > 0 && <p>Not in the forecast: {data.left_out.map((l) => l.label).join(", ")}.</p>}
            </InfoPopover>
          </LegendKey>
          {whatIf.on && whatIf.data && <LegendKey swatch="dashed">Before your changes</LegendKey>}
        </div>
        <ViewToggle value={view} onChange={setView} />
      </header>
      {view === "graph" ? (
        <>
          <div className="px-2 pb-2 pt-3 sm:px-3" role="img" aria-label={summary}>
            <CashAreaChart
              series={data.series}
              currency={currency}
              height={280}
              safetyLevelMinor={data.safety_level_minor}
              lowest={data.lowest}
              markers={markers}
              before={whatIf.on && whatIf.data ? base.series : undefined}
              highlight={highlight}
            />
          </div>
          {strip}
        </>
      ) : (
        <div className="px-2 pb-4 pt-3 sm:px-3">
          <DataTable
            caption={summary}
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
          />
        </div>
      )}
    </Surface>
  );
}

function WhatIfBar({ data, currency, updating, onReset }: { data: WhatIfResult | undefined; currency: string; updating: boolean; onReset: () => void }) {
  const w = data?.what_if;
  const diff = w ? w.lowest_after.balance_minor - w.lowest_before.balance_minor : 0;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-primary-soft/50 px-5 py-2.5">
      <Badge variant="accent">What-if</Badge>
      <p className="min-w-0 flex-1 text-sm">
        {w ? (
          <>
            Lowest point <Money minor={w.lowest_after.balance_minor} currency={currency} className="font-medium" /> on {formatDate(w.lowest_after.date)}, instead of{" "}
            <Money minor={w.lowest_before.balance_minor} currency={currency} />
            {diff !== 0 && (
              <span className={diff > 0 ? "text-positive" : "text-danger"}>
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
  );
}
