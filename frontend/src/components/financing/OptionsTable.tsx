import { CreditCardIcon, FileTextIcon, HandshakeIcon, LandmarkIcon, ReceiptIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { FinancingOption, FinancingOptionType } from "@/api/types";
import { Disclosure, IconTile } from "@/components/kit";
import { Money } from "@/components/Money";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ICONS: Record<FinancingOptionType, LucideIcon> = {
  supplier_terms: HandshakeIcon,
  early_payment: ReceiptIcon,
  credit_line: CreditCardIcon,
  term_loan: LandmarkIcon,
  invoice_finance: FileTextIcon,
  merchant_cash_advance: ZapIcon,
};

/** Cheapest first; options we couldn't cost go last. */
export const byCost = (a: FinancingOption, b: FinancingOption) =>
  (a.quote?.total_cost_minor ?? Number.POSITIVE_INFINITY) - (b.quote?.total_cost_minor ?? Number.POSITIVE_INFINITY);

/**
 * The options that fit, as one comparison table: what each costs in total (with a bar so the
 * cheapest shows at a glance), what it costs a month and whether it covers the gap. A row opens
 * the details.
 */
export function OptionsTable({
  options,
  need,
  currency,
  selectedId,
  onSelect,
  limit = 5,
}: {
  options: FinancingOption[];
  need: number | null;
  currency: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const sorted = [...options].sort(byCost);
  const shown = all ? sorted : sorted.slice(0, limit);
  const most = Math.max(1, ...sorted.map((o) => o.quote?.total_cost_minor ?? 0));
  return (
    <div>
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">Options you can use, cheapest first</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">
              Option
            </th>
            <th scope="col" className="w-24 py-2 pr-3 text-right font-medium sm:w-44 sm:text-left">
              Total cost
            </th>
            <th scope="col" className="hidden w-24 py-2 pr-3 text-right font-medium md:table-cell">
              A month
            </th>
            <th scope="col" className="hidden w-28 py-2 font-medium sm:table-cell">
              Gap
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => {
            const q = o.quote;
            const fits = q?.closes_gap ?? false;
            const pct = q ? (q.total_cost_minor / most) * 100 : 0;
            const short = q && !q.covers_need && need ? <>Up to <Money minor={q.amount_minor} currency={currency} /></> : null;
            return (
              <tr
                key={o.id}
                data-option={o.id}
                className={cn("cursor-pointer border-t transition-colors hover:bg-accent/60", o.id === selectedId && "bg-accent/60")}
                onClick={() => onSelect(o.id)}
              >
                <td className="py-3 pr-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <IconTile icon={ICONS[o.type] ?? LandmarkIcon} tone={o.free ? "positive" : "neutral"} className="max-sm:hidden" />
                    <div className="min-w-0">
                      <button
                        type="button"
                        className="line-clamp-2 text-left font-medium hover:underline focus-visible:underline"
                        aria-pressed={o.id === selectedId}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(o.id);
                        }}
                      >
                        {o.product}
                      </button>
                      <div className="truncate text-xs text-muted-foreground">{o.provider}</div>
                      {q && (
                        <StatusDot status={fits ? "positive" : "warning"} label={fits ? "Covers the gap" : "Falls short"} showLabel className="mt-1 text-xs text-muted-foreground sm:hidden" />
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-3 pr-3 text-right sm:text-left">
                  {!q ? (
                    <span className="text-muted-foreground">–</span>
                  ) : o.free || q.total_cost_minor === 0 ? (
                    <Badge variant="positive">Free</Badge>
                  ) : (
                    <span className="flex items-center justify-end gap-3 sm:justify-start">
                      <Money minor={q.total_cost_minor} currency={currency} className="font-medium sm:w-20" />
                      <span className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
                        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(pct, 2)}%` }} />
                      </span>
                    </span>
                  )}
                </td>
                <td className="hidden py-3 pr-3 text-right md:table-cell">
                  {q ? q.monthly_repayment_minor ? <Money minor={q.monthly_repayment_minor} currency={currency} /> : <span className="text-muted-foreground">Nothing</span> : "–"}
                </td>
                <td className="hidden py-3 sm:table-cell">
                  {q && (
                    <span className="grid gap-0.5">
                      <Badge variant={fits ? "positive" : "warning"} className="w-fit">
                        {fits ? "Covers it" : "Falls short"}
                      </Badge>
                      {short && <span className="text-xs text-muted-foreground">{short}</span>}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > limit && (
        <button type="button" className="mt-2 text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

/** Options the business can't use yet, folded away, each with what would change that. */
export function NotYet({ options, onSelect }: { options: FinancingOption[]; onSelect: (id: string) => void }) {
  if (options.length === 0) return null;
  return (
    <Disclosure summary={`${options.length} not available yet`}>
      <ul className="divide-y border-y">
        {options.map((o) => (
          <li key={o.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{o.product}</div>
              <ul className="mt-0.5 grid gap-0.5">
                {o.reasons.map((r) => (
                  <li key={r} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot status="warning" label="Not yet" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
            <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => onSelect(o.id)} aria-label={`See what ${o.product} would cost`}>
              See cost
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
