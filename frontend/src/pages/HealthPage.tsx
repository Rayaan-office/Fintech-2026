import { ChartColumnIcon, CircleCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { useBusinessHealth, useCashFlow } from "@/api/hooks";
import type { BusinessHealth, HealthCheck } from "@/api/types";
import { ChartCard } from "@/components/ChartCard";
import { AgeingBar } from "@/components/health/AgeingBar";
import { HealthStats } from "@/components/health/HealthStats";
import { ProfitChart } from "@/components/health/ProfitChart";
import { Initials } from "@/components/Initials";
import { Disclosure, Donut, InfoPopover, Section, ShareBars, StatStrip, Surface } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, ChartSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot, type Status } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatPercent } from "@/lib/format";

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
    <div className="grid grid-cols-1 gap-8">
      <PageHeader title="Business health" />
      <QueryView
        query={health}
        loading={
          <div className="grid gap-8" aria-busy="true">
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

  return (
    <>
      <HealthStats data={data} currency={currency} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-3">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList aria-label="Choose a chart" className="max-w-full justify-start overflow-x-auto [scrollbar-width:none]">
              {(Object.keys(VIEWS) as View[]).map((v) => (
                <TabsTrigger key={v} value={v}>
                  {VIEWS[v]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {view === "pnl" && <ProfitView data={data} currency={currency} />}
          {view === "spending" && <SpendingView data={data} currency={currency} />}
          {view === "suppliers" && <SuppliersView data={data} currency={currency} />}
          {view === "owed" && <OwedView data={data} currency={currency} />}
        </div>
        <HealthChecks checks={data.checks} />
      </div>
    </>
  );
}

/** A view's bordered surface with its heading, the same shape as a chart card. */
function ViewSurface({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <Surface>
      <section aria-label={title}>
        <header className="flex flex-wrap items-baseline gap-2 px-5 pt-4">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {aside && <span className="text-sm text-muted-foreground">{aside}</span>}
        </header>
        <div className="px-5 pb-5 pt-4">{children}</div>
      </section>
    </Surface>
  );
}

const None = ({ children }: { children: ReactNode }) => <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;

function ProfitView({ data, currency }: { data: BusinessHealth; currency: string }) {
  const money = (minor: number) => <Money minor={minor} currency={currency} />;
  const months = data.profit_and_loss;
  return (
    <ChartCard
      title="Profit by month"
      summary="Profit for each month: sales minus costs, before VAT."
      table={{
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
      }}
    >
      <ProfitChart months={months} currency={currency} />
    </ChartCard>
  );
}

function SpendingView({ data, currency }: { data: BusinessHealth; currency: string }) {
  const total = data.spending.reduce((s, r) => s + r.amount_minor, 0);
  return (
    <ViewSurface title="Where the money goes" aside="last 90 days">
      {data.spending.length === 0 ? (
        <None>No spending in the last 90 days.</None>
      ) : (
        <div className="grid gap-5">
          <Donut
            slices={data.spending.map((s) => ({ id: s.category, label: s.category, minor: s.amount_minor }))}
            currency={currency}
            label="Spending by category over the last 90 days, before VAT"
            centre={
              <>
                <span className="text-xs text-muted-foreground">Spent</span>
                <Money minor={total} currency={currency} className="text-sm font-semibold" />
              </>
            }
          />
          {data.spending.length > 5 && (
            <Disclosure summary={`All ${data.spending.length} categories`}>
              <ShareBars rows={data.spending.map((s) => ({ id: s.category, label: s.category, minor: s.amount_minor }))} currency={currency} labelHeading="Category" valueHeading="Spent" />
            </Disclosure>
          )}
        </div>
      )}
    </ViewSurface>
  );
}

function SuppliersView({ data, currency }: { data: BusinessHealth; currency: string }) {
  return (
    <ViewSurface title="Biggest suppliers" aside="last 90 days">
      {data.top_suppliers.length === 0 ? (
        <None>No supplier spending in the last 90 days.</None>
      ) : (
        <ShareBars
          rows={data.top_suppliers.map((s) => ({ id: s.name, label: s.name, leading: <Initials name={s.name} size="sm" />, minor: s.amount_minor }))}
          currency={currency}
          labelHeading="Supplier"
          valueHeading="Spent"
          limit={5}
        />
      )}
    </ViewSurface>
  );
}

/** "Corner Deli invoice INV-2077" → "Corner Deli": the forecast names each unpaid invoice this way. */
const customerOf = (label: string) => label.replace(/\s+invoice(\s+\S+)?$/i, "").trim() || label;

function OwedView({ data, currency }: { data: BusinessHealth; currency: string }) {
  const o = data.owed;
  if (o.count === 0) {
    return (
      <ViewSurface title="Unpaid invoices">
        <None>No unpaid invoices. Nobody owes you anything right now.</None>
      </ViewSurface>
    );
  }
  return (
    <ViewSurface title="Unpaid invoices" aside="by how overdue">
      <div className="grid gap-6">
        <StatStrip
          items={[
            { label: "Owed", value: <Money minor={o.total_minor} currency={currency} />, note: `${o.count} ${o.count === 1 ? "invoice" : "invoices"}` },
            { label: "Overdue", value: <Money minor={o.overdue_minor} currency={currency} />, tone: o.overdue_minor > 0 ? "warning" : "default", note: `${Math.round(o.over_30_share * 100)}% over 30 days` },
          ]}
        />
        <AgeingBar buckets={data.who_owes_you} currency={currency} />
        <ByCustomer currency={currency} />
        {o.other_currencies > 0 && (
          <p className="text-xs text-muted-foreground">
            {o.other_currencies} more in other currencies {o.other_currencies === 1 ? "isn't" : "aren't"} included.
          </p>
        )}
      </div>
    </ViewSurface>
  );
}

/** Who owes the most, from the unpaid invoices the forecast is waiting on. */
function ByCustomer({ currency }: { currency: string }) {
  const flow = useCashFlow();
  const totals = new Map<string, number>();
  for (const it of flow.data?.items ?? []) {
    if (it.kind !== "invoice" || it.amount_minor <= 0) continue;
    const who = customerOf(it.label);
    totals.set(who, (totals.get(who) ?? 0) + it.amount_minor);
  }
  if (totals.size === 0) return null;
  const rows = [...totals].sort((a, b) => b[1] - a[1]).map(([name, minor]) => ({ id: name, label: name, leading: <Initials name={name} size="sm" />, minor }));
  return <ShareBars rows={rows} currency={currency} labelHeading="Customer" valueHeading="Owed" limit={5} />;
}

const SEVERITY: Record<HealthCheck["severity"], { status: Status; label: string }> = {
  urgent: { status: "danger", label: "Urgent" },
  attention: { status: "warning", label: "Needs attention" },
  info: { status: "positive", label: "Healthy" },
};

function HealthChecks({ checks }: { checks: HealthCheck[] }) {
  return (
    <Section
      title="Health checks"
      aside={checks.length > 0 ? String(checks.length) : undefined}
      className="content-start"
      actions={
        <InfoPopover label="What we check" title="What we check">
          <p>We compare costs with sales and look at your margin, overdue invoices and runway.</p>
        </InfoPopover>
      }
    >
      {checks.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 shrink-0 text-positive" aria-hidden /> Nothing stands out right now.
        </p>
      ) : (
        <ul className="divide-y border-y">
          {checks.map((c) => {
            const s = SEVERITY[c.severity];
            return (
              <li key={c.id} className="flex items-start gap-3 py-3">
                <StatusDot status={s.status} label={s.label} className="mt-1.5" />
                <p className="min-w-0 flex-1 text-sm">{c.sentence}</p>
                <InfoPopover label="Why am I seeing this?" title="Why you're seeing this" className="-mt-0.5 shrink-0">
                  <p>{c.why}</p>
                </InfoPopover>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
