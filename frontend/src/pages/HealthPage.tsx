import { ChartColumnIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
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

type View = "pnl" | "spending" | "owed";

export default function HealthPage() {
  const health = useBusinessHealth();
  return (
    <div className="grid gap-6">
      <PageHeader title="Business health" description="How the business is really doing, in plain numbers." />
      <QueryView
        query={health}
        loading={
          <div className="grid gap-6" aria-busy="true">
            <CardsSkeleton count={4} />
            <ChartSkeleton height={280} />
          </div>
        }
        empty={
          <EmptyState
            icon={ChartColumnIcon}
            title="Not enough history yet"
            description="Once we have a month of sales and costs from your connected accounts or documents, your profit, spending and runway appear here."
            action={
              <Button asChild>
                <Link to="/connections">Connect a source</Link>
              </Button>
            }
          />
        }
      >
        {(data) => <HealthContent data={data} />}
      </QueryView>
    </div>
  );
}

function HealthContent({ data }: { data: BusinessHealth }) {
  const currency = useCurrentUser().business.currency;
  const [view, setView] = useState<View>("pnl");
  const money = (minor: number) => <Money minor={minor} currency={currency} />;

  const charts: Record<View, { title: string; summary: string; chart: ReactNode; table: ChartTable }> = {
    pnl: {
      title: "Profit by month",
      summary: "Profit for each month: sales minus costs.",
      chart: <CategoryBarChart data={data.profit_and_loss} categoryKey="month" valueKey="profit_minor" currency={currency} />,
      table: {
        columns: [
          { key: "month", label: "Month" },
          { key: "sales", label: "Sales", numeric: true },
          { key: "costs", label: "Costs", numeric: true },
          { key: "profit", label: "Profit", numeric: true },
        ],
        rows: data.profit_and_loss.map((r) => ({ id: r.month, month: r.month, sales: money(r.sales_minor), costs: money(r.costs_minor), profit: money(r.profit_minor) })),
      },
    },
    spending: {
      title: "Where the money goes",
      summary: "Spending by category for the period.",
      chart: <CategoryBarChart data={data.spending} categoryKey="category" valueKey="amount_minor" currency={currency} />,
      table: {
        columns: [
          { key: "category", label: "Category" },
          { key: "amount", label: "Spent", numeric: true },
        ],
        rows: data.spending.map((r) => ({ id: r.category, category: r.category, amount: money(r.amount_minor) })),
      },
    },
    owed: {
      title: "Who owes you, by how overdue",
      summary: "Unpaid invoices grouped by how overdue they are.",
      chart: <CategoryBarChart data={data.who_owes_you} categoryKey="bucket" valueKey="amount_minor" currency={currency} />,
      table: {
        columns: [
          { key: "bucket", label: "How overdue" },
          { key: "amount", label: "Owed", numeric: true },
        ],
        rows: data.who_owes_you.map((r) => ({ id: r.bucket, bucket: r.bucket, amount: money(r.amount_minor) })),
      },
    },
  };
  const current = charts[view];

  return (
    <>
      <section aria-label={`Headline numbers, ${data.period_label}`} className="grid grid-cols-2 divide-border rounded-xl border bg-card shadow-card sm:grid-cols-4 sm:divide-x">
        <Stat term="Profit" value={money(data.profit_minor)} note={data.period_label} />
        <Stat term="Margin" value={formatPercent(data.margin_pct)} />
        <Stat term="Days to get paid" value={`${Math.round(data.days_to_get_paid)} days`} />
        <Stat term="Runway" value={data.runway_months === null ? "Not burning cash" : `${data.runway_months.toFixed(1)} months`} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <ChartCard
          key={view}
          title={current.title}
          summary={current.summary}
          table={current.table}
          actions={
            <Tabs value={view} onValueChange={(v) => setView(v as View)}>
              <TabsList className="h-8">
                <TabsTrigger value="pnl" className="h-6 px-2 text-xs">Profit and loss</TabsTrigger>
                <TabsTrigger value="spending" className="h-6 px-2 text-xs">Spending</TabsTrigger>
                <TabsTrigger value="owed" className="h-6 px-2 text-xs">Who owes you</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          {current.chart}
        </ChartCard>
        <HealthChecks checks={data.checks} />
      </div>
    </>
  );
}

function Stat({ term, value, note }: { term: MoneyTerm; value: ReactNode; note?: string }) {
  return (
    <div className="p-5">
      <div className="text-sm text-muted-foreground">
        <HelpHint term={term} />
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function HealthChecks({ checks }: { checks: HealthCheck[] }) {
  return (
    <section aria-labelledby="checks-heading" className="rounded-xl border bg-card shadow-card">
      <h2 id="checks-heading" className="px-5 pt-4 text-sm font-medium">
        Health checks
      </h2>
      {checks.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 pt-3 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-positive" aria-hidden /> Nothing stands out right now.
        </p>
      ) : (
        <ul className="divide-y">
          {checks.map((c) => (
            <li key={c.id} className="flex gap-3 px-5 py-3.5">
              {c.severity === "info" ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Healthy" />
              ) : (
                <TriangleAlertIcon className={c.severity === "urgent" ? "mt-0.5 size-4 shrink-0 text-danger" : "mt-0.5 size-4 shrink-0 text-warning"} aria-label={c.severity === "urgent" ? "Urgent" : "Needs attention"} />
              )}
              <div className="grid gap-1">
                <p className="text-sm">{c.sentence}</p>
                {c.severity !== "info" && <WhyHint why={c.why} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
