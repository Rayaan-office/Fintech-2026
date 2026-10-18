import { CalendarPlusIcon, MessageCircleIcon, PlugIcon, UploadIcon } from "lucide-react";
import { Link } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import { useCash, useHome } from "@/api/hooks";
import type { CashPosition, HomeSummary } from "@/api/types";
import { CashTile } from "@/components/home/CashTile";
import { BillsTile, OwedTile, RecommendationsTile } from "@/components/home/SummaryTiles";
import { TodayList } from "@/components/home/TodayList";
import { QueryView } from "@/components/QueryView";
import { ChartSkeleton, HeadlineSkeleton, ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { firstName, greeting } from "@/lib/format";

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
          <p className="text-[13px] text-muted-foreground">{today}</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">
            {greeting()}, {firstName(me.user.name)}
          </h1>
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
  return (
    <>
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-3">
        <CashTile cash={data.cash} position={position} currency={currency} />
        <div className="grid content-start divide-y max-lg:border-t lg:pt-4">
          <BillsTile bills={data.bills_due} currency={currency} />
          <OwedTile owed={data.who_owes_you} currency={currency} />
          <RecommendationsTile recs={data.recommendations} currency={currency} />
        </div>
      </div>
      <TodayList items={data.today} />
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="grid gap-8" aria-busy="true" aria-label="Loading">
      <div className="grid gap-8 lg:grid-cols-3">
        <div className="grid gap-4 lg:col-span-2">
          <HeadlineSkeleton />
          <ChartSkeleton height={150} />
        </div>
        <ListSkeleton rows={3} />
      </div>
      <ListSkeleton rows={3} />
    </div>
  );
}
