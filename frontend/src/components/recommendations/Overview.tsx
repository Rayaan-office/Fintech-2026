import type { Recommendation, Severity } from "@/api/types";
import { Stat } from "@/components/kit";
import { Money, useMoneyText } from "@/components/Money";
import { cn } from "@/lib/utils";

export const SEVERITIES: Record<Severity, { label: string; dot: string; text: string }> = {
  urgent: { label: "Urgent", dot: "bg-danger", text: "text-danger" },
  attention: { label: "Worth a look", dot: "bg-warning", text: "text-warning" },
  info: { label: "For information", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

const ORDER: Severity[] = ["urgent", "attention", "info"];

/** Money at stake as one number, and what it is made of by severity as a stacked bar. */
export function Overview({ items, currency }: { items: Recommendation[]; currency: string }) {
  const money = useMoneyText();
  const groups = ORDER.map((s) => {
    const of = items.filter((r) => r.severity === s);
    return { s, count: of.length, minor: of.reduce((sum, r) => sum + (r.at_stake_minor ?? 0), 0) };
  }).filter((g) => g.count > 0);
  const total = groups.reduce((sum, g) => sum + g.minor, 0);
  return (
    <section aria-label="Overview" className="grid gap-6 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:items-end sm:gap-12">
      <Stat size="lg" label="At stake" value={<Money minor={total} currency={currency} />} note={`Across ${items.length} ${items.length === 1 ? "recommendation" : "recommendations"}`} />
      <div className="grid gap-3 sm:pb-1">
        {total > 0 && (
          <div
            role="img"
            aria-label={`At stake by severity: ${groups.map((g) => `${SEVERITIES[g.s].label} ${money(g.minor, currency)}`).join(", ")}`}
            className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted"
          >
            {groups
              .filter((g) => g.minor > 0)
              .map((g) => (
                <span key={g.s} className={cn("h-full first:rounded-l-full last:rounded-r-full", SEVERITIES[g.s].dot)} style={{ flexGrow: g.minor, flexBasis: 0 }} />
              ))}
          </div>
        )}
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {groups.map((g) => (
            <div key={g.s} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn("size-2 rounded-full", SEVERITIES[g.s].dot)} aria-hidden />
                {SEVERITIES[g.s].label}
                <span className="tabular">{g.count}</span>
              </dt>
              <dd className="mt-0.5 pl-3.5 text-sm font-medium">
                <Money minor={g.minor} currency={currency} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
