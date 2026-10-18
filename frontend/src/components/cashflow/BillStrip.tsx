import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ForecastBill } from "@/api/types";
import { CASH_CHART_INSET } from "@/components/charts";
import { InfoPopover } from "@/components/kit";
import { Money } from "@/components/Money";
import { addDays, daysBetween, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const CHIP_PX = 148; // a chip's widest, plus a little air: chips closer than this share a row
const LANE_PX = 28;
const LANES_SHOWN = 2; // more rows than this fold behind "Show all"

/** "Acme Supplies Ltd bill AS-1004" → "Acme Supplies Ltd". */
export const payeeOf = (label: string) => label.replace(/ \(next bill\)$/, "").replace(/ bill\b.*$/, "");

/**
 * Unpaid bills on a strip lined up with the chart's days. Drag one (or use the arrow keys)
 * to see what paying it on another day does. Only the what-if changes.
 */
export function BillStrip({
  bills,
  moved,
  today,
  end,
  currency,
  onMove,
  onDragging,
}: {
  bills: ForecastBill[];
  moved: Record<string, string>;
  today: string;
  end: string;
  currency: string;
  onMove: (id: string, date: string) => void;
  onDragging: (id: string | null) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [preview, setPreview] = useState<{ id: string; date: string } | null>(null);
  const [all, setAll] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const span = Math.max(1, daysBetween(today, end));

  useLayoutEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && e.contentRect.width > 0 && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [bills.length]);

  if (bills.length === 0) return null;

  const committed = (b: ForecastBill) => moved[b.id] ?? b.date;
  const dateOf = (b: ForecastBill) => (preview?.id === b.id ? preview.date : committed(b));
  const clamp = (d: number) => Math.min(span, Math.max(1, d));
  const gap = Math.min(0.5, CHIP_PX / Math.max(width, 1));
  const layout = (items: { id: string; at: number }[]) => {
    const lanes: number[] = [];
    const lane = new Map<string, number>();
    for (const p of [...items].sort((a, b) => a.at - b.at)) {
      let i = lanes.findIndex((last) => p.at - last >= gap);
      if (i === -1) i = lanes.length;
      lanes[i] = p.at;
      lane.set(p.id, i);
    }
    return { count: lanes.length, lane };
  };
  // Which bills sit on the folded strip is decided by their own dates, so moving one never hides it;
  // a moved, focused or dragged bill always stays
  const original = layout(bills.map((b) => ({ id: b.id, at: daysBetween(today, b.date) / span })));
  const keep = (b: ForecastBill) => all || (original.lane.get(b.id) ?? 0) < LANES_SHOWN || moved[b.id] !== undefined || b.id === focused || b.id === preview?.id;
  const placed = bills
    .filter(keep)
    .map((b) => ({ bill: b, date: dateOf(b), at: daysBetween(today, dateOf(b)) / span }))
    .sort((a, b) => a.at - b.at);
  const { count: rows, lane } = layout(placed.map((p) => ({ id: p.bill.id, at: p.at })));
  const hidden = bills.length - placed.length;

  const dayAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 1;
    return clamp(Math.round(((clientX - r.left) / r.width) * span));
  };

  const onPointerDown = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPreview({ id: b.id, date: dateOf(b) });
    onDragging(b.id);
  };
  const onPointerMove = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    if (preview?.id !== b.id) return;
    setPreview({ id: b.id, date: addDays(today, dayAt(e.clientX)) });
  };
  const onPointerUp = (b: ForecastBill) => () => {
    if (preview?.id === b.id && preview.date !== committed(b)) onMove(b.id, preview.date);
    setPreview(null);
    onDragging(null);
  };
  const onKeyDown = (b: ForecastBill) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 7, PageDown: -7 };
    const now = daysBetween(today, committed(b));
    const next = e.key === "Home" ? 1 : e.key === "End" ? span : e.key in steps ? clamp(now + steps[e.key]!) : null;
    if (next === null) return;
    e.preventDefault();
    onMove(b.id, addDays(today, next));
  };

  return (
    <section aria-labelledby="move-heading" className="border-t px-2 pb-3 pt-3 sm:px-3">
      <div className="flex items-center justify-between gap-2 px-3">
        <h3 id="move-heading" className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          Move a bill
          <InfoPopover label="How moving a bill works" title="Move a bill">
            <p>Drag a bill to another day, or focus it and use the arrow keys (Page Up and Page Down move a week).</p>
            <p>We redraw the forecast to show what paying it then would do. Nothing is saved and your records don't change.</p>
          </InfoPopover>
        </h3>
        {original.count > LANES_SHOWN && (
          <button type="button" className="text-xs font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${bills.length}`}
          </button>
        )}
      </div>
      <div className="mt-1.5" style={{ paddingLeft: CASH_CHART_INSET.left, paddingRight: CASH_CHART_INSET.right }}>
        <div ref={track} className="relative border-t border-dashed" style={{ height: rows * LANE_PX + 6 }}>
          {placed.map(({ bill, date, at }) => {
            const isMoved = moved[bill.id] !== undefined && moved[bill.id] !== bill.date;
            const days = daysBetween(today, date);
            return (
              <button
                key={bill.id}
                type="button"
                role="slider"
                aria-label={`Move ${bill.label}`}
                aria-valuemin={1}
                aria-valuemax={span}
                aria-valuenow={days}
                aria-valuetext={formatDate(date, true)}
                onPointerDown={onPointerDown(bill)}
                onPointerMove={onPointerMove(bill)}
                onPointerUp={onPointerUp(bill)}
                onPointerCancel={() => {
                  setPreview(null);
                  onDragging(null);
                }}
                onKeyDown={onKeyDown(bill)}
                onFocus={() => {
                  setFocused(bill.id);
                  onDragging(bill.id);
                }}
                onBlur={() => {
                  setFocused(null);
                  onDragging(null);
                }}
                title={`${bill.label}, ${formatDate(date)}`}
                className={cn(
                  "absolute flex max-w-[9rem] cursor-grab touch-none select-none items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs shadow-card transition-colors hover:border-foreground/30 active:cursor-grabbing",
                  isMoved && "border-primary/40 bg-primary-soft text-primary",
                  preview?.id === bill.id && "z-10 ring-2 ring-ring",
                )}
                style={{ left: `${at * 100}%`, top: 6 + (lane.get(bill.id) ?? 0) * LANE_PX, transform: `translateX(-${at * 100}%)` }}
              >
                {(isMoved || preview?.id === bill.id) && <span className="shrink-0 tabular">{formatDate(date)}</span>}
                <span className="min-w-0 truncate">{payeeOf(bill.label)}</span>
                <Money minor={bill.amount_minor} currency={currency} className="sr-only" />
              </button>
            );
          })}
        </div>
      </div>
      {hidden > 0 && <span className="sr-only">{hidden} more bills are folded away. Use Show all to move them.</span>}
    </section>
  );
}
