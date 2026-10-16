import { ArrowRightIcon, CalendarPlusIcon, CircleCheckIcon, MessageCircleIcon, PlugIcon, UploadIcon } from "lucide-react";
import { Link } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import { useHome } from "@/api/hooks";
import type { HomeSummary, TodayItem } from "@/api/types";
import { ApprovalBadge } from "@/components/ApprovalBadge";
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
import { firstName, formatDate, formatRelative, greeting } from "@/lib/format";

export default function HomePage() {
  const me = useCurrentUser();
  const can = useCan();
  const home = useHome();
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
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

      <QueryView
        query={home}
        loading={<HomeSkeleton />}
        empty={
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
        }
      >
        {(data) => <HomeContent data={data} currency={me.business.currency} />}
      </QueryView>
    </div>
  );
}

function HomeContent({ data, currency }: { data: HomeSummary; currency: string }) {
  const { cash, bills_due, who_owes_you, recommendations } = data;
  return (
    <>
      <TodayBriefing items={data.today.slice(0, 3)} />

      <div className="grid gap-4">
        <Headline
          label="Cash today"
          value={<CountUp value={cash.balance_minor}>{(v) => <Money minor={v} currency={currency} />}</CountUp>}
          note={`Across all connected accounts · updated ${formatRelative(cash.as_of)}`}
        />
        {cash.forecast.length > 0 && (
          <ChartCard
            title="Next 90 days"
            summary="Expected cash for the next 90 days, with a best-to-worst band."
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
          </ChartCard>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label={<HelpHint term="Bills due" />}
          value={<Money minor={bills_due.total_minor} currency={currency} />}
          note={
            bills_due.count === 0
              ? "No bills waiting"
              : `${bills_due.count} ${bills_due.count === 1 ? "bill" : "bills"}${bills_due.next_due_date ? ` · next on ${formatDate(bills_due.next_due_date)}` : ""}`
          }
          footer={<CardLink to="/documents">View bills</CardLink>}
        />
        <SummaryCard
          label={<HelpHint term="Who owes you" />}
          value={<Money minor={who_owes_you.total_minor} currency={currency} />}
          note={
            who_owes_you.overdue_minor > 0 ? (
              <span className="flex items-center gap-1.5">
                <StatusDot status="warning" label="Needs attention" />
                <Money minor={who_owes_you.overdue_minor} currency={currency} /> overdue
              </span>
            ) : (
              `${who_owes_you.count} unpaid ${who_owes_you.count === 1 ? "invoice" : "invoices"}`
            )
          }
          footer={<CardLink to="/health">View who owes you</CardLink>}
        />
        <SummaryCard
          label="Recommendations"
          value={recommendations.count}
          note={
            recommendations.at_stake_minor > 0 ? (
              <>
                <Money minor={recommendations.at_stake_minor} currency={currency} /> at stake
              </>
            ) : (
              "Nothing to look at right now"
            )
          }
          footer={<CardLink to="/recommendations">View recommendations</CardLink>}
        />
      </div>
    </>
  );
}

function TodayBriefing({ items }: { items: TodayItem[] }) {
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
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <StatusDot status={item.severity === "urgent" ? "danger" : item.severity === "attention" ? "warning" : "accent"} label={item.severity} />
              <p className="min-w-0 flex-1 text-sm">{item.sentence}</p>
              <ApprovalBadge level={item.level} />
              <Button asChild size="sm">
                <Link to={item.href}>{item.action_label}</Link>
              </Button>
            </li>
          ))}
        </ul>
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
