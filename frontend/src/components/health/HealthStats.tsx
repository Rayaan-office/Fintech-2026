import type { ReactNode } from "react";
import type { BusinessHealth } from "@/api/types";
import { HelpHint, type MoneyTerm } from "@/components/HelpHint";
import { Meter, Sparkline } from "@/components/kit";
import { Money } from "@/components/Money";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = { term: MoneyTerm; value: ReactNode; note: ReactNode; visual?: ReactNode; tone?: "default" | "positive" | "warning" | "danger" };

const toneText = { default: "", positive: "text-positive", warning: "text-warning", danger: "text-danger" } as const;

/**
 * The four headline numbers in a row divided by hairlines, each with a small picture where the
 * data allows one (monthly profit as a sparkline, margin as a meter).
 */
export function HealthStats({ data, currency }: { data: BusinessHealth; currency: string }) {
  const money = (minor: number, direction: "auto" | "in" | "out" = "auto") => <Money minor={minor} currency={currency} direction={direction} />;
  const full = data.period_label !== "";
  const hasSales = full && data.sales_minor !== 0;
  // Whole months only: a part month would read as a sudden drop
  const monthly = data.profit_and_loss.filter((m) => m.complete).map((m) => m.profit_minor);

  const runway: Item =
    data.runway_months !== null
      ? {
          term: "Runway",
          value: `${data.runway_months.toFixed(1)} months`,
          note: <>Down {money(-data.monthly_net_minor)} a month</>,
          tone: data.runway_months < 3 ? "danger" : data.runway_months < 6 ? "warning" : "default",
        }
      : data.monthly_net_minor > 0
        ? { term: "Runway", value: "Cash is growing", note: <>{money(data.monthly_net_minor, "in")} a month</>, tone: "positive" }
        : { term: "Runway", value: "–", note: "No money moved in 3 months" };

  const items: Item[] = [
    {
      term: "Profit",
      value: full ? money(data.profit_minor) : "–",
      note: full ? data.period_label : "We need a full month of records",
      visual: full && monthly.length >= 2 ? <Sparkline values={monthly} label={`Profit for each of the last ${monthly.length} full months`} tone="accent" height={28} /> : undefined,
    },
    {
      term: "Margin",
      value: hasSales ? formatPercent(data.margin_pct) : "–",
      note: hasSales ? <>On {money(data.sales_minor)} of sales</> : "No sales in a full month yet",
      visual: hasSales ? <Meter value={Math.max(0, data.margin_pct)} max={100} label={`Margin ${formatPercent(data.margin_pct)}`} tone={data.margin_pct < 0 ? "danger" : "accent"} className="mb-1.5" /> : undefined,
    },
    {
      term: "Days to get paid",
      value: data.days_to_get_paid === null ? "–" : `${Math.round(data.days_to_get_paid)} days`,
      note: data.days_to_get_paid === null ? "No invoices paid in 90 days" : "Last 90 days",
    },
    runway,
  ];

  return (
    <section aria-label={full ? `Headline numbers, ${data.period_label}` : "Headline numbers"}>
      <dl className="grid grid-cols-2 gap-y-6 lg:flex lg:divide-x">
        {items.map((s, i) => (
          <div key={s.term} data-stat={s.term} className={cn("min-w-0 lg:flex-1 lg:px-7 lg:first:pl-0 lg:last:pr-0", i % 2 === 1 && "max-lg:pl-5")}>
            <dt className="text-[13px] text-muted-foreground">
              <HelpHint term={s.term} />
            </dt>
            <dd className="mt-1.5 flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className={cn("text-2xl font-semibold tracking-tight tabular", toneText[s.tone ?? "default"])}>{s.value}</span>
              {s.visual && <span className="block w-20 max-w-full">{s.visual}</span>}
            </dd>
            <dd className="mt-1 text-[13px] text-muted-foreground">{s.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
