import { ArrowRightIcon, ClockIcon, LandmarkIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { CashPosition, HomeSummary } from "@/api/types";
import { DataTable } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { ViewToggle, type ChartView } from "@/components/cashflow/ViewToggle";
import { CountUp } from "@/components/CountUp";
import { Meta, Surface } from "@/components/kit";
import { Money } from "@/components/Money";
import { formatDate, formatRelative } from "@/lib/format";

/** The large tile: cash today, where it sits, and the next 30 days drawn as an area. */
export function CashTile({ cash, position, currency }: { cash: HomeSummary["cash"]; position: CashPosition | null; currency: string }) {
  const [view, setView] = useState<ChartView>("graph");
  const accounts = position?.accounts.filter((a) => a.counted).length;
  const leftOut = position?.left_out ?? [];
  const in30 = cash.horizons["30"];
  const last = cash.forecast.at(-1)?.date;
  const summary = "Expected cash for the next 30 days, with a best-to-worst band.";

  return (
    <Surface className="flex flex-col p-5 sm:p-6 lg:col-span-2" aria-labelledby="cash-heading" role="region">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="cash-heading" className="text-[13px] text-muted-foreground">
            Cash today
          </h2>
          <div className="mt-1 text-3xl font-semibold tracking-tight tabular sm:text-4xl">
            <CountUp value={cash.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>
          </div>
          <Meta
            className="mt-2"
            items={[
              { icon: LandmarkIcon, label: accounts === undefined ? "Connected accounts" : `${accounts} ${accounts === 1 ? "account" : "accounts"}` },
              { icon: ClockIcon, label: `Updated ${formatRelative(cash.as_of)}` },
              leftOut.length > 0 && {
                icon: TriangleAlertIcon,
                label: `${leftOut.length} not counted`,
                title: `Not counted (another currency): ${leftOut.map((a) => `${a.name} (${a.currency})`).join(", ")}`,
              },
            ]}
          />
        </div>
        <Link to="/cash-flow" className="inline-flex items-center gap-1 rounded-full text-sm font-medium text-primary hover:underline">
          View cash flow <ArrowRightIcon className="size-3.5" aria-hidden />
        </Link>
      </div>

      {cash.forecast.length > 0 && (
        <div className="mt-5 flex flex-1 flex-col">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Next 30 days</span>
            <ViewToggle value={view} onChange={setView} />
          </div>
          {view === "graph" ? (
            <div className="mt-2 flex-1">
              <div role="img" aria-label={summary}>
                <CashAreaChart series={cash.forecast} currency={currency} height={150} compact />
              </div>
              {last && (
                <div className="mt-2 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                  <span aria-hidden>Today</span>
                  <span>
                    In 30 days <Money minor={in30} currency={currency} className="ml-1 font-medium text-foreground" />
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="-mx-3 mt-2">
              <DataTable
                caption={summary}
                table={{
                  columns: [
                    { key: "date", label: "Date" },
                    { key: "expected", label: "Expected", numeric: true },
                    { key: "range", label: "Best to worst", numeric: true },
                  ],
                  rows: cash.forecast.map((p) => ({
                    id: p.date,
                    date: formatDate(p.date, true),
                    expected: <Money minor={p.expected_minor} currency={currency} />,
                    range: (
                      <>
                        <Money minor={p.best_minor} currency={currency} /> – <Money minor={p.worst_minor} currency={currency} />
                      </>
                    ),
                  })),
                }}
              />
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}
