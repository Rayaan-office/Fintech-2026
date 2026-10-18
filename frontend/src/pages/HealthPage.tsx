import { ChartColumnIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { useBusinessHealth } from "@/api/hooks";
import type { BusinessHealth, HealthCheck } from "@/api/types";
import { ChartCard, type ChartTable } from "@/components/ChartCard";
import { CategoryBarChart } from "@/components/charts";
import { HelpHint, type MoneyTerm } from "@/components/HelpHint";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, ChartSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WhyHint } from "@/components/WhyHint";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const VIEWS = { pnl: "Profit", spending: "Spending", suppliers: "Suppliers", owed: "Who owes you" } as const;
type View = keyof typeof VIEWS;
const isView = (v: string | null): v is View => v !== null && v in VIEWS;

/** Nothing to measure yet: no sales or costs in any month and nothing owed. */
const isBlank = (h: BusinessHealth) =>
  h.profit_and_loss.every((m) => m.sales_minor === 0 && m.costs_minor === 0) && h.owed.count === 0;

export default function HealthPage() {
  const health = useBusinessHealth();
  const empty = (
    <EmptyState
      icon={ChartColumnIcon}
      title="Not enough history yet"
      description="Once we have sales and costs from your connected accounts or documents, your profit, spending and runway appear here."
      action={
        <Button asChild>
          <Link to="/connections">Connect a source</Link>
        </Button>
      }
    />
  );
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader title="Business health" description="How the business is really doing, in plain numbers." />
      <QueryView
        query={health}
        loading={
          <div className="grid gap-6" aria-busy="true">
            <CardsSkeleton count={4} />
            <ChartSkeleton height={280} />
          </div>
        }
        empty={empty}
      >
        {(data) => (isBlank(data) ? empty : <HealthContent data={data} />)}
      </QueryView>
    </div>
  );
}

/** "Apr 2026 (part)" → "Apr", for the chart's axis; the table keeps the full label. */
const shortMonth = (label: string) => label.split(" ")[0] ?? label;

function HealthContent({ data }: { data: BusinessHealth }) {
  const currency = useCurrentUser().business.currency;
  const [params, setParams] = useSearchParams();
  const view: View = isView(params.get("view")) ? (params.get("view") as View) : "pnl";
  const setView = (v: View) =>
    setParams(
      (p) => {
        if (v === "pnl") p.delete("view");
        else p.set("view", v);
        return p;
      },
      { replace: true },
    );
  const money = (minor: number) => <Money minor={minor} currency={currency} />;
  const months = data.profit_and_loss.map((m) => ({ ...m, short: shortMonth(m.label) }));

  const charts: Record<View, { title: string; summary: string; chart: ReactNode; table: ChartTable; none?: string }> = {
    pnl: {
      title: "Profit by month",
      summary: "Profit for each month: sales minus costs, before VAT.",
      chart: <CategoryBarChart data={months} categoryKey="short" valueKey="profit_minor" currency={currency} />,
      table: {
        columns: [
          { key: "month", label: "Month" },
          { key: "sales", label: "Sales", numeric: true },
          { key: "costs", label: "Costs", numeric: true },
          { key: "profit", label: "Profit", numeric: true },
          { key: "margin", label: "Margin", numeric: true },
        ],
        rows: months.map((r) => ({
          id: r.month,
          month: r.label,
          sales: money(r.sales_minor),
          costs: money(r.costs_minor),
          profit: money(r.profit_minor),
          margin: r.margin_pct === null ? "–" : formatPercent(r.margin_pct),
        })),
      },
    },
    spending: {
      title: "Where the money goes",
      summary: "Spending by category over the last 90 days, before VAT.",
      chart: <CategoryBarChart data={data.spending} categoryKey="category" valueKey="amount_minor" currency={currency} horizontal />,
      table: {
        columns: [
          { key: "category", label: "Category" },
          { key: "amount", label: "Spent", numeric: true },
        ],
        rows: data.spending.map((r) => ({ id: r.category, category: r.category, amount: money(r.amount_minor) })),
      },
      none: data.spending.length === 0 ? "No spending in the last 90 days." : undefined,
    },
    suppliers: {
      title: "Biggest suppliers",
      summary: "The ten suppliers you spent most with over the last 90 days, before VAT.",
      chart: <CategoryBarChart data={data.top_suppliers} categoryKey="name" valueKey="amount_minor" currency={currency} horizontal />,
      table: {
        columns: [
          { key: "name", label: "Supplier" },
          { key: "amount", label: "Spent", numeric: true },
        ],
        rows: data.top_suppliers.map((r) => ({ id: r.name, name: r.name, amount: money(r.amount_minor) })),
      },
      none: data.top_suppliers.length === 0 ? "No supplier spending in the last 90 days." : undefined,
    },
    owed: {
      title: "Who owes you, by how overdue",
      summary: "Unpaid invoices grouped by how overdue they are.",
      chart: <CategoryBarChart data={data.who_owes_you} categoryKey="bucket" valueKey="amount_minor" currency={currency} horizontal />,
      table: {
        columns: [
          { key: "bucket", label: "How overdue" },
          { key: "amount", label: "Owed", numeric: true },
        ],
        rows: data.who_owes_you.map((r) => ({ id: r.bucket, bucket: r.bucket, amount: money(r.amount_minor) })),
      },
      none: data.owed.count === 0 ? "No unpaid invoices. Nobody owes you anything right now." : undefined,
    },
  };
  const current = charts[view];

  return (
    <>
      <HeadlineNumbers data={data} currency={currency} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="grid min-w-0 content-start gap-3">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList aria-label="Choose a chart" className="max-w-full justify-start overflow-x-auto">
              {(Object.keys(VIEWS) as View[]).map((v) => (
                <TabsTrigger key={v} value={v}>
                  {VIEWS[v]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <ChartCard key={view} title={current.title} summary={current.summary} table={current.table}>
            {current.none ? <p className="px-3 py-10 text-center text-sm text-muted-foreground">{current.none}</p> : current.chart}
          </ChartCard>
          {view === "owed" && data.owed.count > 0 && (
            <p className="text-sm text-muted-foreground">
              {money(data.owed.total_minor)} across {data.owed.count} unpaid {data.owed.count === 1 ? "invoice" : "invoices"}, {money(data.owed.overdue_minor)} of it overdue.
              {data.owed.other_currencies > 0 && ` ${data.owed.other_currencies} more in other currencies aren't included.`}
            </p>
          )}
        </div>
        <HealthChecks checks={data.checks} />
      </div>
    </>
  );
}

function HeadlineNumbers({ data, currency }: { data: BusinessHealth; currency: string }) {
  const money = (minor: number, direction: "auto" | "in" | "out" = "auto") => <Money minor={minor} currency={currency} direction={direction} />;
  const full = data.period_label !== "";
  const runway =
    data.runway_months !== null
      ? { value: `${data.runway_months.toFixed(1)} months`, note: <>{money(-data.monthly_net_minor)} a month more going out than coming in</> }
      : data.monthly_net_minor > 0
        ? { value: "Cash is growing", note: <>{money(data.monthly_net_minor, "in")} a month on average</> }
        : { value: "–", note: "No money moved in the last 3 months" };
  return (
    <section
      aria-label={full ? `Headline numbers, ${data.period_label}` : "Headline numbers"}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-4"
    >
      <Stat term="Profit" value={full ? money(data.profit_minor) : "–"} note={full ? data.period_label : "We need a full month of records"} />
      <Stat
        term="Margin"
        value={full && data.sales_minor !== 0 ? formatPercent(data.margin_pct) : "–"}
        note={full && data.sales_minor !== 0 ? <>On {money(data.sales_minor)} of sales</> : "No sales in a full month yet"}
      />
      <Stat
        term="Days to get paid"
        value={data.days_to_get_paid === null ? "–" : `${Math.round(data.days_to_get_paid)} days`}
        note={data.days_to_get_paid === null ? "No invoices paid in the last 90 days" : "Invoice to payment, last 90 days"}
      />
      <Stat term="Runway" value={runway.value} note={runway.note} />
    </section>
  );
}

function Stat({ term, value, note }: { term: MoneyTerm; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 bg-card p-4 sm:p-5">
      <div className="text-sm text-muted-foreground">
        <HelpHint term={term} />
      </div>
      <div className="mt-1.5 truncate text-xl font-semibold tracking-tight tabular sm:text-2xl">{value}</div>
      {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function HealthChecks({ checks }: { checks: HealthCheck[] }) {
  return (
    <section aria-labelledby="checks-heading" className="self-start rounded-xl border bg-card shadow-card">
      <h2 id="checks-heading" className="px-5 pt-4 text-sm font-medium">
        Health checks
      </h2>
      {checks.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 pt-3 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 shrink-0 text-positive" aria-hidden /> Nothing stands out right now. We check costs against sales, your margin, overdue invoices and runway.
        </p>
      ) : (
        <ul className="divide-y">
          {checks.map((c) => (
            <li key={c.id} className="flex gap-3 px-5 py-3.5">
              {c.severity === "info" ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Healthy" />
              ) : (
                <TriangleAlertIcon
                  className={cn("mt-0.5 size-4 shrink-0", c.severity === "urgent" ? "text-danger" : "text-warning")}
                  aria-label={c.severity === "urgent" ? "Urgent" : "Needs attention"}
                />
              )}
              <div className="grid min-w-0 gap-1">
                <p className="text-sm">{c.sentence}</p>
                <WhyHint why={c.why} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
