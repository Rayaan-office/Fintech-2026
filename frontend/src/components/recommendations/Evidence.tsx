import { ArrowRightIcon } from "lucide-react";
import type { Evidence } from "@/api/types";
import { cn } from "@/lib/utils";

/*
 * The numbers behind a recommendation, shown rather than told: a before → now pair with the
 * change beside it, or a small bar chart when the evidence is a run of months.
 */

const NUMBER = /^([£$€]?)\s?(-?[\d,]+(?:\.\d+)?)$/;

function parse(value: string): { n: number; money: boolean } | null {
  const m = NUMBER.exec(value.trim());
  if (!m) return null;
  const n = Number(m[2]!.replace(/,/g, ""));
  return Number.isFinite(n) ? { n, money: Boolean(m[1]) } : null;
}

/** "+18%" for money, "+4" for plain counts such as days late. */
function delta(before: string, after: string): { text: string; up: boolean } | null {
  const a = parse(before);
  const b = parse(after);
  if (!a || !b || a.n === b.n) return null;
  const up = b.n > a.n;
  if (a.money && b.money) {
    if (a.n === 0) return null;
    const pct = ((b.n - a.n) / Math.abs(a.n)) * 100;
    return { text: `${up ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`, up };
  }
  const diff = Math.abs(b.n - a.n);
  return { text: `${up ? "+" : "−"}${Number.isInteger(diff) ? diff : diff.toFixed(1)}`, up };
}

function DeltaChip({ before, after }: { before: string; after: string }) {
  const d = delta(before, after);
  if (!d) return null;
  // Every kind we raise is about something rising (a price, a cost, days late), so up is the warning
  return (
    <span className={cn("rounded-full px-1.5 py-px text-[11px] font-medium tabular", d.up ? "bg-warning-soft text-warning" : "bg-positive-soft text-positive")}>
      {d.text}
    </span>
  );
}

const isSeries = (rows: Evidence[]) => rows.length >= 3 && rows.every((r) => !r.before && parse(r.after) !== null);
const MONTH = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(\s+\d{4})?$/;

/** A run of values (spending by month) as small columns, each with its value and label. */
function SeriesBars({ rows }: { rows: Evidence[] }) {
  const values = rows.map((r) => parse(r.after)!.n);
  const top = Math.max(...values, 1);
  return (
    <figure className="grid gap-2">
      <figcaption className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        Month by month <DeltaChip before={rows[0]!.after} after={rows[rows.length - 1]!.after} />
      </figcaption>
      <div className="grid items-end gap-2" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className="grid gap-1 text-center">
            <span className="truncate text-[11px] tabular text-muted-foreground">{r.after}</span>
            <span className="flex h-20 items-end" aria-hidden>
              <span
                className={cn("w-full rounded-t-md", i === rows.length - 1 ? "bg-primary" : "bg-primary/30")}
                style={{ height: `${Math.max(6, (values[i]! / top) * 100)}%` }}
              />
            </span>
            <span className="truncate text-xs text-muted-foreground">{MONTH.exec(r.label)?.[1] ?? r.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function EvidenceView({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  if (isSeries(evidence)) return <SeriesBars rows={evidence} />;
  return (
    <section aria-label="Before and after">
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">What</th>
            <th scope="col">Before and now</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((e, i) => (
            <tr key={`${e.label}-${i}`} className="border-t align-top first:border-0">
              <th scope="row" className="w-2/5 py-2.5 pr-3 text-left text-[13px] font-normal text-muted-foreground">
                {e.label}
              </th>
              <td className="py-2.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 break-words tabular">
                  {e.before && (
                    <>
                      <span className="text-muted-foreground">{e.before}</span>
                      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="now" />
                    </>
                  )}
                  <span className="font-medium">{e.after}</span>
                  <DeltaChip before={e.before} after={e.after} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
