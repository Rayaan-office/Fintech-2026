import { useState, type ReactNode } from "react";
import { useWhyCashChanged } from "@/api/hooks";
import type { WhyCashChanged as Why, WhyPeriod } from "@/api/types";
import { Worded } from "@/components/AiText";
import { Disclosure, FilterPills } from "@/components/kit";
import { Money } from "@/components/Money";
import { QueryView } from "@/components/QueryView";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const PERIODS: Record<WhyPeriod, string> = { month: "This month", "30d": "Last 30 days" };

/** The change against last period, its drivers drawn as bars either side of zero, and the AI's words folded away. */
export function WhyCashChanged({ currency }: { currency: string }) {
  const [period, setPeriod] = useState<WhyPeriod>("month");
  const why = useWhyCashChanged(period);
  const pills = (
    <FilterPills
      label="Period"
      value={period}
      onChange={setPeriod}
      options={(Object.keys(PERIODS) as WhyPeriod[]).map((p) => ({ value: p, label: PERIODS[p] }))}
    />
  );
  return (
    <QueryView
      query={why}
      loading={
        <div className="grid gap-4">
          {pills}
          <p className="text-sm text-muted-foreground">Looking at what moved…</p>
        </div>
      }
      empty={pills}
    >
      {(w) => <Drivers w={w} currency={currency} dim={why.isFetching && why.isPlaceholderData} pills={pills} />}
    </QueryView>
  );
}

function Drivers({ w, currency, dim, pills }: { w: Why; currency: string; dim: boolean; pills: ReactNode }) {
  const reasons = w.reasons.slice(0, 5);
  const max = Math.max(1, ...reasons.map((r) => Math.abs(r.change_minor)));
  return (
    <div className={cn("grid gap-x-12 gap-y-6 lg:grid-cols-[15rem_minmax(0,1fr)]", dim && "opacity-60")}>
      <div className="grid content-start gap-4">
        {pills}
        <div>
          <div className="text-[13px] text-muted-foreground">
            Change in cash, {formatDate(w.this_period.from)} – {formatDate(w.this_period.to)}
          </div>
          <div className="mt-1 text-2xl font-semibold tracking-tight tabular">
            <Money minor={Math.abs(w.change_minor)} currency={currency} direction={w.change_minor > 0 ? "in" : w.change_minor < 0 ? "out" : "auto"} />
          </div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">
            against {formatDate(w.last_period.from)} – {formatDate(w.last_period.to)}
          </div>
        </div>
      </div>

      <div className="grid content-start gap-5">
        {reasons.length > 0 && (
          <ul className="grid gap-3" aria-label="Reasons, largest first">
            {reasons.map((r) => {
              const more = r.change_minor > 0;
              const pct = (Math.abs(r.change_minor) / max) * 50;
              return (
                <li key={r.group} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6.5rem]">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{r.label}</span>
                    {r.items.length > 0 && <span className="block truncate text-xs text-muted-foreground">{r.items.map((i) => i.label).join(", ")}</span>}
                  </span>
                  {/* Bars either side of a zero line: left is less cash, right is more */}
                  <span className="relative col-span-2 h-2 max-sm:order-last sm:col-span-1" aria-hidden>
                    <span className="absolute inset-y-[-3px] left-1/2 w-px bg-border" />
                    <span
                      className={cn("absolute inset-y-0 rounded-full", more ? "left-1/2 bg-positive/70" : "right-1/2 bg-danger/60")}
                      style={{ width: `${Math.max(pct, 1)}%` }}
                    />
                  </span>
                  <span className="text-right text-sm font-medium">
                    <Money minor={Math.abs(r.change_minor)} currency={currency} direction={more ? "in" : "out"} />
                    <span className="sr-only">{more ? "more cash" : "less cash"}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Disclosure summary="Summary">
          <Worded wording={w.explanation} className="max-w-2xl" />
        </Disclosure>
      </div>
    </div>
  );
}
