import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ForecastPoint } from "@/api/types";
import { formatDate } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";
import { usePrivacy } from "@/lib/privacy";
import { Money } from "./Money";

const axis = { fontSize: 12, fill: "var(--muted-foreground)" };

type Marker = { id: string; date: string; label: string; amount_minor: number };

type CashChartProps = {
  series: ForecastPoint[];
  currency?: string;
  height?: number;
  /** Small version for the home page: no axes or grid, still a tooltip on hover. */
  compact?: boolean;
  safetyLevelMinor?: number;
  lowest?: { date: string; balance_minor: number };
  markers?: Marker[];
  /** The forecast before a what-if, drawn as a dashed line to compare with. */
  before?: { date: string; expected_minor: number }[];
  /** A marker to draw larger, such as the bill being moved. */
  highlight?: string | null;
};

/** The full-size cash chart's plot area starts this far in (margin plus the money axis), so a strip below can line up with its days. */
export const CASH_CHART_INSET = { left: 4 + 56, right: 12 };

/** Cash over time: expected line with a best-to-worst band, bills as markers. */
export function CashAreaChart({ series, currency = "GBP", height = 260, compact = false, safetyLevelMinor, lowest, markers = [], before, highlight }: CashChartProps) {
  const { hidden } = usePrivacy();
  const animate = !useReducedMotion();
  const earlier = new Map((before ?? []).map((p) => [p.date, p.expected_minor]));
  const data = series.map((p) => ({ ...p, band: [p.worst_minor, p.best_minor] as [number, number], before_minor: earlier.get(p.date) }));
  const byDate = new Map(series.map((p) => [p.date, p.expected_minor]));
  const billsOn = new Map<string, Marker[]>();
  for (const m of markers) billsOn.set(m.date, [...(billsOn.get(m.date) ?? []), m]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={compact ? { top: 4, right: 0, bottom: 0, left: 0 } : { top: 8, right: 12, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="cash-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {!compact && <CartesianGrid vertical={false} stroke="var(--chart-grid)" />}
        <XAxis
          dataKey="date"
          hide={compact}
          tick={axis}
          tickLine={false}
          axisLine={false}
          minTickGap={32}
          tickFormatter={(d: string) => formatDate(d)}
        />
        <YAxis
          hide={compact}
          tick={axis}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => (hidden ? "••••" : formatMoneyCompact(v, currency))}
        />
        <Tooltip
          cursor={{ stroke: "var(--border)" }}
          content={({ active, payload, label }) => {
            const point = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!active || !point) return null;
            const bills = billsOn.get(point.date) ?? [];
            return (
              <ChartTooltip title={formatDate(String(label), true)}>
                <Row label="Expected">
                  <Money minor={point.expected_minor} currency={currency} />
                </Row>
                {point.before_minor !== undefined && point.before_minor !== point.expected_minor && (
                  <Row label="Before your changes">
                    <Money minor={point.before_minor} currency={currency} />
                  </Row>
                )}
                <Row label="Best to worst">
                  <Money minor={point.best_minor} currency={currency} /> – <Money minor={point.worst_minor} currency={currency} />
                </Row>
                {bills.slice(0, 3).map((b) => (
                  <Row key={b.id} label={b.label}>
                    <Money minor={b.amount_minor} currency={currency} direction="out" />
                  </Row>
                ))}
                {bills.length > 3 && <div className="text-muted-foreground">and {bills.length - 3} more going out</div>}
              </ChartTooltip>
            );
          }}
        />
        <Area dataKey="band" stroke="none" fill="var(--chart-band)" isAnimationActive={false} activeDot={false} />
        {before && (
          <Area dataKey="before_minor" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="3 3" fill="none" dot={false} activeDot={false} isAnimationActive={false} />
        )}
        <Area
          dataKey="expected_minor"
          stroke="var(--primary)"
          strokeWidth={2}
          fill="url(#cash-fill)"
          dot={false}
          isAnimationActive={animate}
          animationDuration={300}
        />
        {safetyLevelMinor !== undefined && !compact && (
          // Kept in view even when cash stays below it the whole time
          <ReferenceLine
            y={safetyLevelMinor}
            ifOverflow="extendDomain"
            stroke="var(--warning)"
            strokeDasharray="4 4"
            label={{ value: "Safety level", position: "insideTopLeft", ...axis }}
          />
        )}
        {markers.map((m) => {
          const y = byDate.get(m.date);
          const on = m.id === highlight;
          return y === undefined ? null : (
            <ReferenceDot
              key={m.id}
              x={m.date}
              y={y}
              r={on ? 6 : 4}
              fill={on ? "var(--primary)" : "var(--card)"}
              stroke={on ? "var(--card)" : "var(--muted-foreground)"}
              strokeWidth={1.5}
            />
          );
        })}
        {lowest && (
          <ReferenceDot
            x={lowest.date}
            y={lowest.balance_minor}
            r={5}
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth={2}
            label={compact ? undefined : { value: "Lowest", position: "bottom", offset: 10, ...axis, fill: "var(--foreground)", fontWeight: 500 }}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Comparing categories (spending, who owes you, monthly profit). */
export function CategoryBarChart({
  data,
  categoryKey,
  valueKey,
  currency = "GBP",
  height = 260,
  horizontal = false,
}: {
  data: object[];
  categoryKey: string;
  valueKey: string;
  currency?: string;
  height?: number;
  /** Bars across with the names down the side, for long names (categories, suppliers) that would overlap below. */
  horizontal?: boolean;
}) {
  const { hidden } = usePrivacy();
  const money = (v: number) => (hidden ? "••••" : formatMoneyCompact(v, currency));
  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--accent)" }}
      content={({ active, payload, label }) => {
        const value = payload?.[0]?.value;
        if (!active || typeof value !== "number") return null;
        return (
          <ChartTooltip title={String(label)}>
            <Money minor={value} currency={currency} />
          </ChartTooltip>
        );
      }}
    />
  );
  if (horizontal) {
    return (
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36 + 24)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={money} />
          <YAxis
            type="category"
            dataKey={categoryKey}
            tick={axis}
            tickLine={false}
            axisLine={false}
            width={112}
            interval={0}
            tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
          />
          {tooltip}
          <Bar dataKey={valueKey} fill="var(--primary)" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey={categoryKey} tick={axis} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={56} tickFormatter={money} />
        <ReferenceLine y={0} stroke="var(--border)" />
        {tooltip}
        <Bar dataKey={valueKey} fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The forecast with a financing option's money in and repayments added, against the forecast without it. */
export function ForecastEffectChart({
  series,
  without,
  safetyLevelMinor,
  currency = "GBP",
  height = 220,
}: {
  series: { date: string; expected_minor: number }[];
  without?: { date: string; expected_minor: number }[];
  safetyLevelMinor: number;
  currency?: string;
  height?: number;
}) {
  const { hidden } = usePrivacy();
  const before = new Map((without ?? []).map((p) => [p.date, p.expected_minor]));
  const data = series.map((p) => ({ date: p.date, with_minor: p.expected_minor, without_minor: before.get(p.date) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={32} tickFormatter={(d: string) => formatDate(d)} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => (hidden ? "••••" : formatMoneyCompact(v, currency))} />
        <Tooltip
          cursor={{ stroke: "var(--border)" }}
          content={({ active, payload, label }) => {
            const point = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!active || !point) return null;
            return (
              <ChartTooltip title={formatDate(String(label), true)}>
                <Row label="With this">
                  <Money minor={point.with_minor} currency={currency} />
                </Row>
                {point.without_minor !== undefined && (
                  <Row label="Without">
                    <Money minor={point.without_minor} currency={currency} />
                  </Row>
                )}
              </ChartTooltip>
            );
          }}
        />
        <ReferenceLine y={safetyLevelMinor} stroke="var(--warning)" strokeDasharray="4 4" label={{ value: "Safety level", position: "insideTopLeft", ...axis }} />
        {without && (
          <Line dataKey="without_minor" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls />
        )}
        {/* Drawn at once: the sliders re-render it often, which cut the draw-in animation short */}
        <Line dataKey="with_minor" stroke="var(--primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ChartTooltip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-panel">
      <div className="mb-1 font-medium">{title}</div>
      <div className="grid gap-0.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
