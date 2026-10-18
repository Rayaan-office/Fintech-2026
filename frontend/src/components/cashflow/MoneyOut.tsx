import { RepeatIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import type { ForecastBill } from "@/api/types";
import { Initials } from "@/components/Initials";
import { Money } from "@/components/Money";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { payeeOf } from "./BillStrip";

const ROWS = 5; // more than this fold behind "Show all"

/** "Acme Supplies Ltd bill AS-1004" → "AS-1004"; nothing for labels without a reference. */
const refOf = (label: string) => label.match(/ bill (.+)$/)?.[1] ?? null;

/**
 * Money going out in the forecast as a quiet table: when, to whom, how much, and a switch to see
 * the forecast without it.
 */
export function MoneyOut({
  bills,
  excluded,
  moved,
  currency,
  onToggle,
  onPutBack,
}: {
  bills: ForecastBill[];
  excluded: string[];
  moved: Record<string, string>;
  currency: string;
  onToggle: (id: string, on: boolean) => void;
  onPutBack: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (bills.length === 0) return <p className="text-sm text-muted-foreground">Nothing going out in the next 90 days.</p>;
  const shown = all ? bills : bills.slice(0, ROWS);
  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">Money going out. Switch one off to see the forecast without it.</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="w-16 py-2 pr-3 font-medium">
              Date
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Payee
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="w-12 py-2 text-right font-medium">
              <span className="sr-only">In the forecast</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => {
            const included = !excluded.includes(b.id);
            const movedTo = moved[b.id];
            const payee = payeeOf(b.label);
            const ref = refOf(b.label);
            const repeating = b.id.startsWith("repeat:");
            return (
              <tr key={b.id} className={cn("border-t", !included && "text-muted-foreground")}>
                <td className="py-2.5 pr-3 align-middle tabular text-muted-foreground">{formatDate(movedTo ?? b.date)}</td>
                <td className="py-2.5 pr-3 align-middle">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Initials name={payee} size="sm" className={cn(!included && "opacity-50")} />
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate", !included && "line-through")} title={b.label}>
                          {payee}
                        </span>
                        {ref && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{ref}</span>}
                        {repeating && <RepeatIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Repeats" />}
                      </span>
                      {movedTo && (
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-primary">
                          Moved from {formatDate(b.date)}
                          <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => onPutBack(b.id)}>
                            <Undo2Icon className="size-3" aria-hidden /> Put back
                          </button>
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="py-2.5 pr-3 text-right align-middle">
                  <Money minor={b.amount_minor} currency={currency} direction="out" />
                </td>
                <td className="py-2.5 text-right align-middle">
                  <Switch checked={included} aria-label={`Include ${b.label} in the forecast`} onCheckedChange={(on) => onToggle(b.id, on)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {bills.length > ROWS && (
        <button type="button" className="mt-1 text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${bills.length}`}
        </button>
      )}
    </div>
  );
}
