import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthResult } from "@/api/types";
import { Money } from "@/components/Money";
import { formatMoneyCompact } from "@/lib/money";
import { usePrivacy } from "@/lib/privacy";

const axis = { fontSize: 12, fill: "var(--muted-foreground)" };

/** "Apr 2026 (part)" → "Apr", for the axis; the table keeps the full label. */
const shortMonth = (label: string) => label.split(" ")[0] ?? label;

/**
 * Profit for each month: green above the line, red below it, part months paler.
 *
 * Drawn without the grow-in animation on purpose: recharts animates bars from zero height on
 * animation frames, and a page that is in the background (a hidden tab or pane) gets no frames,
 * so the bars stayed at zero height and the chart looked empty.
 */
export function ProfitChart({ months, currency, height = 240 }: { months: MonthResult[]; currency: string; height?: number }) {
  const { hidden } = usePrivacy();
  const data = months.map((m) => ({ ...m, short: shortMonth(m.label) }));
  return (
    <div className="grid gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 text-xs text-muted-foreground" aria-hidden>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-positive" /> Profit
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-danger" /> Loss
        </li>
        {months.some((m) => !m.complete) && (
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-muted-foreground/30" /> Part month
          </li>
        )}
      </ul>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="short" tick={axis} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => (hidden ? "••••" : formatMoneyCompact(v, currency))} />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Tooltip
            cursor={{ fill: "var(--accent)" }}
            content={({ active, payload }) => {
              const m = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !m) return null;
              return (
                <div className="grid min-w-44 gap-0.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-panel">
                  <div className="mb-1 font-medium">{m.label}</div>
                  <Row label="Sales">
                    <Money minor={m.sales_minor} currency={currency} />
                  </Row>
                  <Row label="Costs">
                    <Money minor={m.costs_minor} currency={currency} />
                  </Row>
                  <Row label={m.profit_minor < 0 ? "Loss" : "Profit"}>
                    <Money minor={m.profit_minor} currency={currency} className="font-medium" />
                  </Row>
                </div>
              );
            }}
          />
          <Bar dataKey="profit_minor" radius={3} maxBarSize={36} isAnimationActive={false}>
            {data.map((m) => (
              <Cell key={m.month} fill={m.profit_minor < 0 ? "var(--danger)" : "var(--positive)"} fillOpacity={m.complete ? 0.9 : 0.35} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
