import { ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useRecommendations } from "@/api/hooks";
import type { HomeSummary, Severity } from "@/api/types";
import { HelpHint } from "@/components/HelpHint";
import { Meter } from "@/components/kit";
import { Money } from "@/components/Money";
import { StatusDot } from "@/components/StatusDot";
import { formatDate, localDay } from "@/lib/format";
import { cn } from "@/lib/utils";

export const RANK: Record<Severity, number> = { urgent: 0, attention: 1, info: 2 };

/** One quiet tile in the bento's side column: a label, a link out, a number and one visual line. */
function Tile({ name, label, to, linkLabel, children, className }: { name: string; label: ReactNode; to: string; linkLabel: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={name} className={cn("group/tile grid content-start gap-1.5 py-5 first:pt-0 last:pb-0 max-lg:first:pt-5", className)}>
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span className="flex items-center gap-1">{label}</span>
        <Link
          to={to}
          aria-label={linkLabel}
          title={linkLabel}
          className="-mr-1 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowUpRightIcon className="size-4" aria-hidden />
        </Link>
      </div>
      {children}
    </div>
  );
}

const value = "text-2xl font-semibold tracking-tight tabular";
const note = "flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground";

export function BillsTile({ bills, currency }: { bills: HomeSummary["bills_due"]; currency: string }) {
  const overdue = bills.next_due_date !== null && bills.next_due_date < localDay();
  return (
    <Tile name="Bills due" label={<HelpHint term="Bills due">Bills due</HelpHint>} to="/cash-flow" linkLabel="See them in cash flow">
      <div className="flex items-baseline gap-2">
        <span className={value}>
          <Money minor={bills.total_minor} currency={currency} />
        </span>
        <span className="text-[13px] text-muted-foreground">next 7 days</span>
      </div>
      <div className={note}>
        {bills.count > 0 ? (
          <>
            <span className="text-foreground">
              {bills.count} {bills.count === 1 ? "bill" : "bills"}
            </span>
            {overdue && bills.next_due_date && <StatusDot status="danger" label={`Oldest due ${formatDate(bills.next_due_date)}`} showLabel className="text-[13px]" />}
          </>
        ) : bills.next_due_date ? (
          <span>Next on {formatDate(bills.next_due_date)}</span>
        ) : (
          <StatusDot status="positive" label="No unpaid bills" showLabel className="text-[13px]" />
        )}
      </div>
    </Tile>
  );
}

export function OwedTile({ owed, currency }: { owed: HomeSummary["who_owes_you"]; currency: string }) {
  return (
    <Tile name="Who owes you" label={<HelpHint term="Who owes you" />} to="/health?view=owed" linkLabel="See who owes you">
      <span className={value}>
        <Money minor={owed.total_minor} currency={currency} />
      </span>
      {owed.count === 0 ? (
        <div className={note}>No unpaid invoices</div>
      ) : (
        <>
          <Meter value={owed.overdue_minor} max={owed.total_minor} label="Overdue share of what customers owe" tone="warning" className="mt-1" />
          <div className={cn(note, "justify-between")}>
            {owed.overdue_minor > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status="warning" label="Needs attention" />
                <span>
                  <Money minor={owed.overdue_minor} currency={currency} className="text-foreground" /> overdue
                </span>
              </span>
            ) : (
              <span>None overdue</span>
            )}
            <span>
              {owed.count} {owed.count === 1 ? "invoice" : "invoices"}
            </span>
          </div>
        </>
      )}
    </Tile>
  );
}

export function RecommendationsTile({ recs, currency }: { recs: HomeSummary["recommendations"]; currency: string }) {
  const list = useRecommendations();
  const top = [...(list.data?.items ?? [])].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0];
  return (
    <Tile name="Recommendations" label="Recommendations" to="/recommendations" linkLabel="See recommendations">
      <div className="flex items-baseline gap-2">
        <span className={value}>{recs.count}</span>
        {recs.at_stake_minor > 0 && (
          <span className="text-[13px] text-muted-foreground">
            <Money minor={recs.at_stake_minor} currency={currency} /> at stake
          </span>
        )}
      </div>
      {recs.count === 0 ? (
        <div className={note}>Nothing to look at</div>
      ) : (
        top && (
          <Link
            to={`/recommendations?open=${encodeURIComponent(top.id)}`}
            className="-mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[13px] hover:bg-accent"
          >
            <StatusDot
              status={top.severity === "urgent" ? "danger" : top.severity === "attention" ? "warning" : "accent"}
              label={top.severity === "urgent" ? "Urgent" : top.severity === "attention" ? "Needs attention" : "For your information"}
            />
            <span className="min-w-0 flex-1 truncate">{top.title}</span>
          </Link>
        )
      )}
    </Tile>
  );
}
