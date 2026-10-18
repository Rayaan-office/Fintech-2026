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
  /** Small version for the home page: no axes or grid. */
  compact?: boolean;
  safetyLevelMinor?: number;
  lowest?: { date: string; balance_minor: number };
  markers?: Marker[];
};

/** Cash over time: expected line with a best-to-worst band, bills as markers. */
export function CashAreaChart({ series, currency = "GBP", height = 260, compact = false, safetyLevelMinor, lowest, markers = [] }: CashChartProps) {
  const { hidden } = usePrivacy();
  const animate = !useReducedMotion();
  const data = series.map((p) => ({ ...p, band: [p.worst_minor, p.best_minor] as [number, number] }));
  const byDate = new Map(series.map((p) => [p.date, p.expected_minor]));

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
        {!compact && (
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            content={({ active, payload, label }) => {
              const point = payload?.[0]?.payload as (ForecastPoint & { band: [number, number] }) | undefined;
              if (!active || !point) return null;
              return (
                <ChartTooltip title={formatDate(String(label), true)}>
                  <Row label="Expected">
                    <Money minor={point.expected_minor} currency={currency} />
                  </Row>
                  <Row label="Best to worst">
                    <Money minor={point.best_minor} currency={currency} /> – <Money minor={point.worst_minor} currency={currency} />
                  </Row>
                </ChartTooltip>
              );
            }}
          />
        )}
        <Area dataKey="band" stroke="none" fill="var(--chart-band)" isAnimationActive={false} activeDot={false} />
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
          <ReferenceLine y={safetyLevelMinor} stroke="var(--warning)" strokeDasharray="4 4" label={{ value: "Safety level", position: "insideTopLeft", ...axis }} />
        )}
        {markers.map((m) => {
          const y = byDate.get(m.date);
          return y === undefined ? null : <ReferenceDot key={m.id} x={m.date} y={y} r={4} fill="var(--card)" stroke="var(--muted-foreground)" strokeWidth={1.5} />;
        })}
        {lowest && (
          <ReferenceDot x={lowest.date} y={lowest.balance_minor} r={5} fill="var(--primary)" stroke="var(--card)" strokeWidth={2} />
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
}: {
  data: object[];
  categoryKey: string;
  valueKey: string;
  currency?: string;
  height?: number;
}) {
  const { hidden } = usePrivacy();
  const animate = !useReducedMotion();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey={categoryKey} tick={axis} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => (hidden ? "••••" : formatMoneyCompact(v, currency))} />
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
        <Bar dataKey={valueKey} fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={animate} animationDuration={300} />
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
