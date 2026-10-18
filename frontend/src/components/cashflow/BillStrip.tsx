import { RotateCcwIcon } from "lucide-react";
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ForecastBill } from "@/api/types";
import { Initials } from "@/components/Initials";
import { InfoPopover } from "@/components/kit";
import { Money } from "@/components/Money";
import { addDays, daysBetween, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const SHOWN = 5; // the soonest bills; the rest fold behind "Show all"

/** "Acme Supplies Ltd bill AS-1004" → "Acme Supplies Ltd". */
export const payeeOf = (label: string) => label.replace(/ \(next bill\)$/, "").replace(/ bill\b.*$/, "");
/** "Acme Supplies Ltd bill AS-1004" → "AS-1004", so two bills from one supplier can be told apart. */
const refOf = (label: string) => (/ \(next bill\)$/.test(label) ? "Next bill" : (/ bill (.+)$/.exec(label)?.[1] ?? null));

/** The first of each month inside the window, as a share of the way along it. */
function monthTicks(today: string, span: number) {
  const ticks: { at: number; label: string }[] = [];
  const [y, m] = today.split("-").map(Number);
  for (let k = 1; k <= 4; k++) {
    const first = new Date(Date.UTC(y!, m! - 1 + k, 1)).toISOString().slice(0, 10);
    const days = daysBetween(today, first);
    if (days > 0 && days < span) ticks.push({ at: days / span, label: new Date(`${first}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) });
  }
  return ticks;
}

/**
 * Unpaid bills, one row each in date order: who, how much, and a handle on a 90-day line. Drag the
 * handle (or use the arrow keys) to see what paying it on another day does. Only the what-if changes.
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
  const [preview, setPreview] = useState<{ id: string; date: string } | null>(null);
  const [all, setAll] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const span = Math.max(1, daysBetween(today, end));

  if (bills.length === 0) return null;

  const committed = (b: ForecastBill) => moved[b.id] ?? b.date;
  const dateOf = (b: ForecastBill) => (preview?.id === b.id ? preview.date : committed(b));
  const clamp = (d: number) => Math.min(span, Math.max(1, d));
  const at = (iso: string) => Math.min(1, Math.max(0, daysBetween(today, iso) / span));
  // Rows keep their own date order while a bill moves, so nothing jumps under the pointer; a moved,
  // focused or dragged bill always stays on the folded list
  const ordered = [...bills].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const rows = ordered.filter((b, i) => all || i < SHOWN || moved[b.id] !== undefined || b.id === focused || b.id === preview?.id);
  const ticks = monthTicks(today, span);

  const dayAt = (track: Element | null, clientX: number) => {
    const r = track?.getBoundingClientRect();
    if (!r || r.width === 0) return 1;
    return clamp(Math.round(((clientX - r.left) / r.width) * span));
  };
  const onPointerDown = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPreview({ id: b.id, date: dateOf(b) });
    onDragging(b.id);
  };
  const onPointerMove = (b: ForecastBill) => (e: PointerEvent<HTMLButtonElement>) => {
    if (preview?.id !== b.id) return;
    setPreview({ id: b.id, date: addDays(today, dayAt(e.currentTarget.parentElement, e.clientX)) });
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
    <section aria-labelledby="move-heading" className="border-t px-5 pb-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id="move-heading" className="flex items-center gap-1 text-sm font-semibold">
          Move a bill
          <InfoPopover label="How moving a bill works" title="Move a bill">
            <p>Drag a bill's date along its line, or focus it and use the arrow keys (Page Up and Page Down move a week).</p>
            <p>We redraw the forecast to show what paying it then would do. Nothing is saved and your records don't change.</p>
          </InfoPopover>
        </h3>
        {bills.length > SHOWN && (
          <button type="button" className="text-xs font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${bills.length}`}
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[17rem_minmax(0,1fr)] sm:gap-x-6">
        {/* Month marks above the lines */}
        <div className="relative col-start-1 hidden h-4 text-[11px] text-muted-foreground sm:col-start-2 sm:block" aria-hidden>
          <span className="absolute left-0">Today</span>
          {ticks.map((t) => (
            <span key={t.label} className="absolute -translate-x-1/2" style={{ left: `${t.at * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <ul className="contents">
          {rows.map((bill) => {
            const date = dateOf(bill);
            const isMoved = date !== bill.date;
            const where = at(date);
            return (
              <li key={bill.id} className="contents">
                <div className="flex min-w-0 items-center gap-2.5 pt-3 sm:py-2">
                  <Initials name={payeeOf(bill.label)} size="sm" />
                  <span className="grid min-w-0 flex-1" title={bill.label}>
                    <span className="truncate text-sm">{payeeOf(bill.label)}</span>
                    {refOf(bill.label) && <span className="truncate text-xs text-muted-foreground">{refOf(bill.label)}</span>}
                  </span>
                  <Money minor={bill.amount_minor} currency={currency} className="shrink-0 text-sm font-medium tabular" />
                </div>
                <div className="flex min-w-0 items-center gap-1.5 pb-3 pt-1 sm:py-2">
                  <div className="relative h-7 min-w-0 flex-1">
                    {/* The line, the month marks and where the bill was */}
                    <span className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden />
                    {ticks.map((t) => (
                      <span key={t.label} className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-border" style={{ left: `${t.at * 100}%` }} aria-hidden />
                    ))}
                    {isMoved && (
                      <>
                        <span
                          className="absolute top-1/2 h-px -translate-y-1/2 border-t border-dashed border-primary/50"
                          style={{ left: `${Math.min(at(bill.date), where) * 100}%`, width: `${Math.abs(where - at(bill.date)) * 100}%` }}
                          aria-hidden
                        />
                        <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-muted-foreground/60 bg-card" style={{ left: `${at(bill.date) * 100}%` }} aria-hidden />
                      </>
                    )}
                    <button
                      type="button"
                      role="slider"
                      aria-label={`Move ${bill.label}`}
                      aria-valuemin={1}
                      aria-valuemax={span}
                      aria-valuenow={daysBetween(today, date)}
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
                      title={`${bill.label}, ${formatDate(date)}. Drag to try another day.`}
                      className={cn(
                        "absolute top-1/2 flex h-6 cursor-grab touch-none select-none items-center whitespace-nowrap rounded-full border bg-card px-2 text-xs font-medium tabular shadow-sm transition-colors hover:border-foreground/30 active:cursor-grabbing",
                        isMoved && "border-primary/40 bg-primary-soft text-primary",
                        preview?.id === bill.id && "z-10 ring-2 ring-ring",
                      )}
                      style={{ left: `${where * 100}%`, transform: `translate(-${where * 100}%, -50%)` }}
                    >
                      {formatDate(date)}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground", !isMoved && "invisible")}
                    onClick={() => onMove(bill.id, bill.date)}
                    aria-label={`Put ${payeeOf(bill.label)} back on ${formatDate(bill.date)}`}
                    tabIndex={isMoved ? 0 : -1}
                    aria-hidden={!isMoved}
                  >
                    <RotateCcwIcon className="size-3.5" aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
