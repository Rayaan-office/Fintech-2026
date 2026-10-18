import { useId } from "react";
import { Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { FinancingGap } from "@/api/types";
import { addDays, daysBetween, formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { usePrivacy } from "@/lib/privacy";

type Point = { date: string; expected_minor: number };

/**
 * The cash dip under the safety level, small: the forecast around the gap with the line turning
 * red where it is below the safety level. Falls back to a plain timeline when there is no
 * forecast to draw.
 */
export function GapPicture({ gap, series, currency }: { gap: FinancingGap; series?: Point[]; currency: string }) {
  const from = addDays(gap.starts_on, -10);
  const to = addDays(gap.ends_on, 7);
  const window = (series ?? []).filter((p) => p.date >= from && p.date <= to);
  return window.length >= 8 ? <GapChart gap={gap} points={window} currency={currency} /> : <GapTimeline gap={gap} />;
}

function GapChart({ gap, points, currency }: { gap: FinancingGap; points: Point[]; currency: string }) {
  const { hidden } = usePrivacy();
  const id = useId().replace(/:/g, "");
  const values = points.map((p) => p.expected_minor);
  const lo = Math.min(...values, gap.lowest_minor, gap.safety_level_minor);
  const hi = Math.max(...values, gap.safety_level_minor);
  const pad = (hi - lo) * 0.08 || 1;
  const [top, bottom] = [hi + pad, lo - pad];
  // Where the safety level sits from the top of the plot, for the red-below gradient
  const split = Math.min(1, Math.max(0, (top - gap.safety_level_minor) / (top - bottom)));
  const first = points[0]!.date;
  const last = points[points.length - 1]!.date;
  const label = hidden
    ? `Cash falls below the safety level from ${formatDate(gap.starts_on)} to ${formatDate(gap.ends_on)}`
    : `Cash falls below the safety level of ${formatMoney(gap.safety_level_minor, currency)} from ${formatDate(gap.starts_on)} to ${formatDate(gap.ends_on)}, lowest ${formatMoney(gap.lowest_minor, currency)} on ${formatDate(gap.lowest_on)}`;
  return (
    <figure className="grid gap-1.5">
      <div role="img" aria-label={label} className="h-24 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 6, right: 6, bottom: 2, left: 6 }}>
            <defs>
              <linearGradient id={`gap-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={split} stopColor="var(--primary)" />
                <stop offset={split} stopColor="var(--danger)" />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[bottom, top]} />
            <ReferenceArea x1={gap.starts_on} x2={gap.ends_on} fill="var(--danger)" fillOpacity={0.06} stroke="none" ifOverflow="extendDomain" />
            <ReferenceLine y={gap.safety_level_minor} stroke="var(--warning)" strokeDasharray="4 4" label={{ value: "Safety level", position: "insideBottomLeft", fontSize: 11, fill: "var(--muted-foreground)" }} />
            <Line dataKey="expected_minor" type="monotone" stroke={`url(#gap-${id})`} strokeWidth={2} dot={false} isAnimationActive={false} />
            <ReferenceDot x={gap.lowest_on} y={gap.lowest_minor} r={4} fill="var(--danger)" stroke="var(--card)" strokeWidth={2} ifOverflow="extendDomain" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular" aria-hidden>
        <span>{formatDate(first)}</span>
        <span className="text-danger">
          {formatDate(gap.starts_on)} → {formatDate(gap.ends_on)}
        </span>
        <span>{formatDate(last)}</span>
      </figcaption>
    </figure>
  );
}

/** A plain bar from the day cash dips below the safety level to the day it recovers, with the low point marked. */
function GapTimeline({ gap }: { gap: FinancingGap }) {
  const span = Math.max(1, daysBetween(gap.starts_on, gap.ends_on));
  const at = Math.min(100, Math.max(0, (daysBetween(gap.starts_on, gap.lowest_on) / span) * 100));
  return (
    <figure className="grid gap-2" aria-label={`Below the safety level from ${formatDate(gap.starts_on)} to ${formatDate(gap.ends_on)}, lowest on ${formatDate(gap.lowest_on)}`}>
      <div className="relative h-2 rounded-full bg-danger-soft">
        <span className="absolute inset-y-0 left-0 rounded-full bg-danger/40" style={{ width: `${at}%` }} />
        <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-danger" style={{ left: `${at}%` }} />
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular">
        <span>{formatDate(gap.starts_on)}</span>
        <span>Lowest {formatDate(gap.lowest_on)}</span>
        <span>{formatDate(gap.ends_on)}</span>
      </figcaption>
    </figure>
  );
}
