/**
 * The building blocks every page shares, so pages show rather than tell: numbers set in a row
 * instead of boxed cards, share-of-total bars, a donut for "what is it made of", sparklines for
 * trends, and the longer words tucked behind an info button or a "Details" fold.
 */
import { ChevronDownIcon, InfoIcon, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltip } from "recharts";
import { usePrivacy } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { Money } from "./Money";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/* ------------------------------------------------------------------ layout */

/** A titled block of a page. No box: space and a heading do the separating. */
export function Section({
  title,
  aside,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  /** A few quiet words beside the title, such as a count or a period. */
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const auto = useId();
  const headingId = id ?? auto;
  return (
    <section aria-labelledby={headingId} className={cn("grid gap-3", className)}>
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id={headingId} className="flex items-baseline gap-2 text-[15px] font-semibold tracking-tight">
          {title}
          {aside && <span className="text-sm font-normal text-muted-foreground">{aside}</span>}
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A quiet bordered surface, for the few places that need one (a chart, a list). */
export function Surface({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-xl border bg-card", className)} {...props}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ numbers */

export type StatItem = {
  label: ReactNode;
  value: ReactNode;
  /** One short line under the value: a change, a date, a count. */
  note?: ReactNode;
  /** A small visual beside the value, such as a sparkline or a meter. */
  visual?: ReactNode;
  tone?: "default" | "positive" | "warning" | "danger";
};

const toneText = { default: "", positive: "text-positive", warning: "text-warning", danger: "text-danger" } as const;

/** One number with its label. */
export function Stat({ label, value, note, visual, tone = "default", size = "md", className }: StatItem & { size?: "md" | "lg"; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-end gap-3">
        <div className={cn("font-semibold tracking-tight tabular", size === "lg" ? "text-3xl sm:text-4xl" : "text-xl", toneText[tone])}>{value}</div>
        {visual && <div className="mb-1 min-w-0 flex-1">{visual}</div>}
      </div>
      {note && <div className="mt-1 text-[13px] text-muted-foreground">{note}</div>}
    </div>
  );
}

/** A row of numbers divided by hairlines, the way a statement header reads. Wraps on phones. */
export function StatStrip({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-y-5 sm:flex sm:flex-wrap sm:divide-x", className)}>
      {items.map((s, i) => (
        <div key={i} className={cn("min-w-0 sm:flex-1 sm:px-6 sm:first:pl-0 sm:last:pr-0", i % 2 === 1 && "max-sm:pl-4")}>
          <dt className="text-[13px] text-muted-foreground">{s.label}</dt>
          <dd className="mt-1 flex items-end gap-3">
            <span className={cn("text-xl font-semibold tracking-tight tabular", toneText[s.tone ?? "default"])}>{s.value}</span>
            {s.visual && <span className="mb-1 min-w-0 max-w-28 flex-1">{s.visual}</span>}
          </dd>
          {s.note && <dd className="mt-0.5 text-[13px] text-muted-foreground">{s.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** How far along something is: "1 of 2 approvals", money used of a limit. */
export function Meter({ value, max, label, tone = "accent", className }: { value: number; max: number; label: string; tone?: "accent" | "positive" | "warning" | "danger"; className?: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const fill = { accent: "bg-primary", positive: "bg-positive", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ charts */

export const CHART_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

export type ShareRow = { id: string; label: ReactNode; leading?: ReactNode; minor: number; href?: string; onClick?: () => void };

/**
 * A list where each row shows its share of the total as a small bar, like a bank's "top spend".
 * Better than a pie when there are many rows or the names matter.
 */
export function ShareBars({ rows, currency, labelHeading = "Name", valueHeading = "Amount", limit, className }: { rows: ShareRow[]; currency: string; labelHeading?: string; valueHeading?: string; limit?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const total = rows.reduce((s, r) => s + Math.abs(r.minor), 0);
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  return (
    <div className={className}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">{labelHeading}</th>
            <th scope="col" className="hidden w-[38%] py-2 pr-3 font-medium sm:table-cell">Share</th>
            <th scope="col" className="py-2 text-right font-medium">{valueHeading}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const pct = total ? (Math.abs(r.minor) / total) * 100 : 0;
            const clickable = Boolean(r.onClick);
            return (
              <tr
                key={r.id}
                className={cn("border-t", clickable && "cursor-pointer hover:bg-accent/60")}
                onClick={r.onClick}
                onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), r.onClick?.()) : undefined}
                tabIndex={clickable ? 0 : undefined}
              >
                <td className="py-2.5 pr-3">
                  <span className="flex min-w-0 items-center gap-2.5">
                    {r.leading}
                    <span className="truncate">{r.label}</span>
                  </span>
                </td>
                <td className="hidden py-2.5 pr-3 sm:table-cell">
                  <span className="flex items-center gap-2.5">
                    <span className="w-10 text-right text-xs text-muted-foreground tabular">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(pct, 1.5)}%` }} />
                    </span>
                  </span>
                </td>
                <td className="py-2.5 text-right font-medium">
                  <Money minor={r.minor} currency={currency} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {limit && rows.length > limit && (
        <button type="button" className="mt-1 text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

export type Slice = { id: string; label: string; minor: number };

/**
 * What a total is made of, for a handful of parts (up to five; the rest are folded into "Other").
 * Always drawn with its legend and amounts, so colour is never the only signal.
 */
export function Donut({ slices, currency, centre, label, size = 168, className }: { slices: Slice[]; currency: string; centre?: ReactNode; label: string; size?: number; className?: string }) {
  // No grow-in animation: it needs animation frames, which a background tab never gets, so it could stay empty
  const { hidden } = usePrivacy();
  const sorted = [...slices].filter((s) => s.minor > 0).sort((a, b) => b.minor - a.minor);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((s, x) => s + x.minor, 0);
  const parts = rest > 0 ? [...top, { id: "other", label: "Other", minor: rest }] : top;
  const total = parts.reduce((s, p) => s + p.minor, 0);
  return (
    <div className={cn("flex flex-col items-center gap-5 sm:flex-row sm:items-center", className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={parts} dataKey="minor" nameKey="label" innerRadius="68%" outerRadius="100%" paddingAngle={parts.length > 1 ? 1.5 : 0} stroke="none" isAnimationActive={false}>
              {parts.map((p, i) => (
                <Cell key={p.id} fill={CHART_COLOURS[i % CHART_COLOURS.length]} />
              ))}
            </Pie>
            {!hidden && (
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) =>
                  active && payload?.[0] ? (
                    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-panel">
                      {String(payload[0].name)} · {total ? Math.round((Number(payload[0].value) / total) * 100) : 0}%
                    </div>
                  ) : null
                }
              />
            )}
          </PieChart>
        </ResponsiveContainer>
        {centre && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">{centre}</div>}
      </div>
      <ul className="grid w-full min-w-0 flex-1 gap-2 text-sm">
        {parts.map((p, i) => (
          <li key={p.id} className="flex items-center gap-2.5">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CHART_COLOURS[i % CHART_COLOURS.length] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            <span className="text-xs text-muted-foreground tabular">{total ? Math.round((p.minor / total) * 100) : 0}%</span>
            <Money minor={p.minor} currency={currency} className="w-24 text-right font-medium" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A tiny trend line with no axes, beside a number. */
export function Sparkline({ values, label, tone = "accent", height = 32, className }: { values: number[]; label: string; tone?: "accent" | "positive" | "danger" | "muted"; height?: number; className?: string }) {
  const stroke = { accent: "var(--primary)", positive: "var(--positive)", danger: "var(--danger)", muted: "var(--muted-foreground)" }[tone];
  if (values.length < 2) return null;
  return (
    <div className={cn("w-full", className)} style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={values.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line type="monotone" dataKey="v" stroke={stroke} strokeWidth={1.75} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ words, tucked away */

/**
 * The longer explanation, one click away: an info button opening a small panel. Use instead of
 * a paragraph on the page.
 */
export function InfoPopover({ label = "More about this", title, children, className }: { label?: string; title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={cn("inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground", className)}>
          <InfoIcon className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-4 text-sm">
        {title && <div className="mb-1.5 font-medium">{title}</div>}
        <div className="grid gap-2 text-muted-foreground">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

/** A fold for detail most people won't need: closed by default. */
export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        {summary}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="pt-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type MetaItem = { icon: LucideIcon; label: ReactNode; /** Said on hover and to screen readers when the label is short. */ title?: string };

/**
 * Small facts about a record as icon + word chips, instead of "Bill · by email · INV-1051.pdf".
 */
export function Meta({ items, className }: { items: (MetaItem | false | null | undefined)[]; className?: string }) {
  const shown = items.filter(Boolean) as MetaItem[];
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}>
      {shown.map((m, i) => {
        const Icon = m.icon;
        const chip = (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{m.label}</span>
          </span>
        );
        return m.title ? (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label={m.title} className="min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {chip}
              </span>
            </TooltipTrigger>
            <TooltipContent>{m.title}</TooltipContent>
          </Tooltip>
        ) : (
          <span key={i} className="min-w-0">
            {chip}
          </span>
        );
      })}
    </span>
  );
}

/** Label and value pairs, two to a row on wider screens. */
export function KeyValues({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2", className)}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 font-medium">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Pill-shaped filters for a list ("All", "Needs a check" ...), with counts. */
export function FilterPills<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
              active ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className={cn("tabular text-xs", active ? "text-background/70" : "text-muted-foreground")}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A round icon tile, used to mark a kind of thing (a recommendation type, a source). */
export function IconTile({ icon: Icon, tone = "neutral", className }: { icon: LucideIcon; tone?: "neutral" | "accent" | "positive" | "warning" | "danger"; className?: string }) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    accent: "bg-primary-soft text-primary",
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  };
  return (
    <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full", tones[tone], className)} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}
