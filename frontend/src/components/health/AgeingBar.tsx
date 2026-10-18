import { Money } from "@/components/Money";

/** From "not yet due" (calm blue) to "over 90 days" (red): later buckets read as more urgent. */
const AGE_COLOURS = ["var(--chart-2)", "var(--chart-5)", "var(--warning)", "color-mix(in oklch, var(--danger) 65%, var(--card))", "var(--danger)"];

/**
 * What customers owe, split by how overdue it is, as one stacked bar with a legend of amounts
 * below (so colour is never the only signal).
 */
export function AgeingBar({ buckets, currency }: { buckets: { bucket: string; amount_minor: number }[]; currency: string }) {
  const total = buckets.reduce((s, b) => s + Math.max(0, b.amount_minor), 0);
  const pct = (minor: number) => (total ? (minor / total) * 100 : 0);
  const colour = (i: number) => AGE_COLOURS[Math.min(i, AGE_COLOURS.length - 1)];
  const label = `Money owed by how overdue: ${buckets
    .filter((b) => b.amount_minor > 0)
    .map((b) => `${b.bucket} ${Math.round(pct(b.amount_minor))}%`)
    .join(", ")}`;
  return (
    <div className="grid gap-4">
      <div role="img" aria-label={label} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {buckets.map((b, i) =>
          b.amount_minor > 0 ? (
            <span
              key={b.bucket}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${pct(b.amount_minor)}%`,
                background: colour(i),
              }}
            />
          ) : null,
        )}
      </div>
      {/* Empty buckets stay out of the legend: they add rows without saying anything */}
      <ul className="grid gap-2 text-sm">
        {buckets.map((b, i) =>
          b.amount_minor <= 0 ? null : (
            <li key={b.bucket} className="flex items-center gap-2.5">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: colour(i) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{b.bucket}</span>
              <span className="w-10 text-right text-xs text-muted-foreground tabular">{Math.round(pct(b.amount_minor))}%</span>
              <Money minor={b.amount_minor} currency={currency} className="w-24 text-right font-medium" />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
