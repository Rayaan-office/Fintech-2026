import { ArrowRightIcon, CalendarPlusIcon, CircleCheckIcon, MessageCircleIcon, PlugIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import { useCash, useHome, useRecommendations } from "@/api/hooks";
import type { CashPosition, HomeSummary, Severity, TodayItem } from "@/api/types";
import { ChartCard } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { CountUp } from "@/components/CountUp";
import { HelpHint } from "@/components/HelpHint";
import { Money } from "@/components/Money";
import { Headline, SummaryCard } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, ChartSkeleton, HeadlineSkeleton, ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { firstName, formatDate, formatRelative, greeting, localDay } from "@/lib/format";

const BRIEFING = 4; // more than this folds behind "Show more"
const RANK: Record<Severity, number> = { urgent: 0, attention: 1, info: 2 };

export default function HomePage() {
  const me = useCurrentUser();
  const can = useCan();
  const home = useHome();
  const cash = useCash();
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

  const empty = (
    <EmptyState
      icon={PlugIcon}
      title="Your money picture starts here"
      description="Connect your bank, payment platform or bills inbox, or upload a statement. Your cash, bills and a 90-day forecast will appear here."
      action={
        <>
          <Button asChild>
            <Link to="/connections">Connect a source</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/documents?upload=1">Upload a document</Link>
          </Button>
        </>
      }
    />
  );

  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">
            {greeting()}, {firstName(me.user.name)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{today}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <Link to="/documents?upload=1">
              <UploadIcon aria-hidden /> Upload
            </Link>
          </Button>
          {can("use_assistant") && (
            <Button asChild variant="secondary">
              <Link to="/ask">
                <MessageCircleIcon aria-hidden /> Ask
              </Link>
            </Button>
          )}
          <Button asChild variant="secondary">
            <Link to="/cash-flow?plan=1">
              <CalendarPlusIcon aria-hidden /> Plan a cost
            </Link>
          </Button>
        </div>
      </div>

      <QueryView query={home} loading={<HomeSkeleton />} empty={empty}>
        {(data) => (isBlank(data, cash.data) ? empty : <HomeContent data={data} position={cash.data ?? null} currency={me.business.currency} />)}
      </QueryView>
    </div>
  );
}

/** Nothing connected and nothing recorded yet. */
function isBlank(data: HomeSummary, position: CashPosition | null | undefined): boolean {
  return (
    position?.accounts.length === 0 &&
    data.cash.balance_minor === 0 &&
    data.bills_due.next_due_date === null &&
    data.who_owes_you.count === 0 &&
    data.recommendations.count === 0
  );
}

function HomeContent({ data, position, currency }: { data: HomeSummary; position: CashPosition | null; currency: string }) {
  const { cash } = data;
  const accounts = position?.accounts.filter((a) => a.counted).length;
  const where = accounts === undefined ? "Across your connected accounts" : `Across ${accounts} ${accounts === 1 ? "account" : "accounts"}`;
  return (
    <>
      <TodayBriefing items={data.today} />

      <div className="grid gap-4">
        <Headline
          label="Cash today"
          value={<CountUp value={cash.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>}
          note={
            <>
              {where} · updated {formatRelative(cash.as_of)}
              {position && position.left_out.length > 0 && (
                <span className="block text-xs">Not counted (another currency): {position.left_out.map((a) => `${a.name} (${a.currency})`).join(", ")}</span>
              )}
            </>
          }
        />
        {cash.forecast.length > 0 && (
          <ChartCard
            title="Next 30 days"
            summary="Expected cash for the next 30 days, with a best-to-worst band."
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
            actions={
              <Button asChild variant="link" size="sm">
                <Link to="/cash-flow">
                  View cash flow <ArrowRightIcon aria-hidden />
                </Link>
              </Button>
            }
          >
            <CashAreaChart series={cash.forecast} currency={currency} height={140} compact />
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 px-3 text-sm">
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">In 30 days</dt>
                <dd className="font-medium">
                  <Money minor={cash.horizons["30"]} currency={currency} />
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">
                  <HelpHint term="Lowest point">Lowest in 90 days</HelpHint>
                </dt>
                <dd className="font-medium">
                  <Money minor={cash.lowest.balance_minor} currency={currency} /> <span className="font-normal text-muted-foreground">on {formatDate(cash.lowest.date)}</span>
                </dd>
              </div>
            </dl>
          </ChartCard>
        )}
      </div>

      <Cards data={data} currency={currency} />
    </>
  );
}

function Cards({ data, currency }: { data: HomeSummary; currency: string }) {
  const { bills_due, who_owes_you, recommendations } = data;
  const recs = useRecommendations();
  const top = [...(recs.data?.items ?? [])].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0];
  const today = localDay();

  const billsNote =
    bills_due.count > 0
      ? `${bills_due.count} ${bills_due.count === 1 ? "bill" : "bills"} due in the next 7 days` +
        (bills_due.next_due_date && bills_due.next_due_date < today ? ` · oldest was due ${formatDate(bills_due.next_due_date)}` : "")
      : bills_due.next_due_date
        ? `Nothing due in the next 7 days · next on ${formatDate(bills_due.next_due_date)}`
        : "No unpaid bills";

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SummaryCard
        label={<HelpHint term="Bills due">Bills due this week</HelpHint>}
        value={<Money minor={bills_due.total_minor} currency={currency} />}
        note={billsNote}
        footer={<CardLink to="/cash-flow">See them in cash flow</CardLink>}
      />
      <SummaryCard
        label={<HelpHint term="Who owes you" />}
        value={<Money minor={who_owes_you.total_minor} currency={currency} />}
        note={
          who_owes_you.overdue_minor > 0 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusDot status="warning" label="Needs attention" />
              <Money minor={who_owes_you.overdue_minor} currency={currency} /> overdue
            </span>
          ) : who_owes_you.count === 0 ? (
            "No unpaid invoices"
          ) : (
            `${who_owes_you.count} unpaid ${who_owes_you.count === 1 ? "invoice" : "invoices"}, none overdue`
          )
        }
        footer={<CardLink to="/health?view=owed">See who owes you</CardLink>}
      />
      <SummaryCard
        label="Recommendations"
        value={recommendations.count}
        note={
          recommendations.count === 0 ? (
            "Nothing to look at right now"
          ) : (
            <>
              {top && <span className="line-clamp-2 text-foreground">{top.title}</span>}
              {recommendations.at_stake_minor > 0 && (
                <span className="block">
                  <Money minor={recommendations.at_stake_minor} currency={currency} /> at stake
                </span>
              )}
            </>
          )
        }
        footer={<CardLink to={top ? `/recommendations?open=${encodeURIComponent(top.id)}` : "/recommendations"}>See recommendations</CardLink>}
      />
    </div>
  );
}

function TodayBriefing({ items }: { items: TodayItem[] }) {
  const [all, setAll] = useState(false);
  // Most pressing first; the server's order is kept within each level
  const sorted = [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const shown = all ? sorted : sorted.slice(0, BRIEFING);
  return (
    <section aria-labelledby="today-heading" className="rounded-xl border bg-card shadow-card">
      <h2 id="today-heading" className="px-5 pt-4 text-sm font-medium">
        Today
      </h2>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 pt-3 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-positive" aria-hidden />
          Nothing needs you today.
        </p>
      ) : (
        <>
          <ul className="divide-y">
            {shown.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                <StatusDot
                  status={item.severity === "urgent" ? "danger" : item.severity === "attention" ? "warning" : "accent"}
                  label={item.severity === "urgent" ? "Urgent" : item.severity === "attention" ? "Needs attention" : "For your information"}
                />
                <p className="min-w-0 flex-1 text-sm">{item.sentence}</p>
                <Button asChild size="sm" variant={item.severity === "info" ? "secondary" : "default"}>
                  <Link to={item.href}>{item.action_label}</Link>
                </Button>
              </li>
            ))}
          </ul>
          {sorted.length > BRIEFING && (
            <div className="border-t px-5 py-2.5">
              <button type="button" className="text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
                {all ? "Show fewer" : `Show ${sorted.length - BRIEFING} more`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CardLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
      {children} <ArrowRightIcon className="size-3.5" aria-hidden />
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div className="grid gap-8" aria-busy="true" aria-label="Loading">
      <ListSkeleton rows={3} />
      <div className="grid gap-4">
        <HeadlineSkeleton />
        <ChartSkeleton height={140} />
      </div>
      <CardsSkeleton />
    </div>
  );
}
