import { CheckIcon, CreditCardIcon, Loader2Icon, ReceiptIcon, ShieldCheckIcon } from "lucide-react";
import { useCurrentUser, useCan } from "@/api/auth";
import { useGettingPaid } from "@/api/hooks";
import type { CardRate, GettingPaidDetail, PaymentCostsDetail, PaymentMethodRow, Recommendation, ReminderDetail } from "@/api/types";
import { Disclosure, InfoPopover, StatStrip, type StatItem } from "@/components/kit";
import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
 * Getting paid on recommendations: the reminder step as a three-step track, the invoices it
 * covers, how each way of paying compares (days to pay as bars), and recording what arrived short.
 */

export const isReminder = (d: GettingPaidDetail | null | undefined): d is ReminderDetail => Boolean(d && "reminder" in d);
export const isPaymentCosts = (d: GettingPaidDetail | null | undefined): d is PaymentCostsDetail => Boolean(d && "methods" in d);

const LINK_TEXT = {
  all: "Includes a link to pay online by card, made only once the reminder is approved.",
  some: "Some of these invoices get a link to pay online by card, made only once the reminder is approved.",
  none: "No card payment link: payment links aren't set up yet. Add a payment link key to include one.",
} as const;

const STEPS = ["Friendly", "Firm", "Final notice"] as const;

/** "Reminder 2 of 3" as three small marks, for a list row. */
export function ReminderChip({ rec }: { rec: Recommendation }) {
  const d = rec.getting_paid;
  if (!isReminder(d)) return null;
  const r = d.reminder;
  const final = r.stage === r.of;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`${STEPS[r.stage - 1] ?? "Reminder"} reminder`}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: r.of }, (_, i) => (
          <span key={i} className={cn("h-1.5 w-2.5 rounded-full", i < r.stage ? (final ? "bg-warning" : "bg-primary") : "bg-muted-foreground/25")} />
        ))}
      </span>
      <span className="tabular">
        Reminder {r.stage} of {r.of}
      </span>
    </span>
  );
}

/** Friendly, firm, final: where this reminder sits, and when the earlier ones went. */
export function ReminderSteps({ detail }: { detail: ReminderDetail }) {
  const r = detail.reminder;
  return (
    <ol aria-label={`Reminder ${r.stage} of ${r.of}`} className="flex items-start">
      {STEPS.slice(0, r.of).map((label, i) => {
        const n = i + 1;
        const sent = r.previous.find((p) => p.stage === n);
        const done = n < r.stage;
        const current = n === r.stage;
        const last = n === r.of;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className={cn("grid min-w-0 gap-1.5", !last && "flex-1")}>
            <span className="flex items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular",
                  done && "bg-primary-soft text-primary",
                  current && (last ? "bg-warning text-white" : "bg-primary text-primary-foreground"),
                  !done && !current && "border bg-card text-muted-foreground",
                )}
                aria-hidden
              >
                {done ? <CheckIcon className="size-3.5" /> : n}
              </span>
              {!last && <span className={cn("mx-2 h-px flex-1", done ? "bg-primary/40" : "bg-border")} aria-hidden />}
            </span>
            <span className={cn("text-xs", current ? "font-medium" : "text-muted-foreground")}>{label}</span>
            <span className="text-[11px] text-muted-foreground">{sent ? `Sent ${formatDate(sent.sent_on, true)}` : current ? "This one" : done ? "Sent" : "\u00a0"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The reminder track, the invoices it covers and whether it carries a payment link. */
export function ReminderInvoices({ detail }: { detail: ReminderDetail }) {
  const currency = useCurrentUser().business.currency;
  const r = detail.reminder;
  return (
    <section aria-label="Invoices in this reminder" className="grid gap-4 text-sm">
      <ReminderSteps detail={detail} />
      <ul className="divide-y rounded-lg border">
        {r.invoices.map((i) => (
          <li key={i.record_id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{i.reference ?? "Invoice"}</span>
              <span className="block text-xs text-muted-foreground">
                due {formatDate(i.due, true)},{" "}
                <span className={i.days_overdue > 30 ? "text-danger" : "text-warning"}>
                  {i.days_overdue} {i.days_overdue === 1 ? "day" : "days"} overdue
                </span>
              </span>
            </span>
            <Money minor={i.open_minor} currency={currency} className="font-medium" />
          </li>
        ))}
      </ul>
      <div className="grid gap-1.5 text-xs text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <CreditCardIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          {LINK_TEXT[r.link]}
        </p>
        {r.owner_only && (
          <p className="flex items-start gap-1.5">
            <ShieldCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />A business owner approves
          </p>
        )}
      </div>
    </section>
  );
}

const cardFeeNote = (rate: CardRate) =>
  rate.source === "yours" ? `Card fees at your own rate (${rate.label}).` : `Card fees are an estimate at ${rate.label}, as you have too few card payments of your own.`;

/** How each way of paying compares: days to get paid as bars, what arrived short, what card costs. */
export function MethodTable({ methods, rate, caption }: { methods: PaymentMethodRow[]; rate: CardRate; caption: string }) {
  const currency = useCurrentUser().business.currency;
  const slowest = Math.max(1, ...methods.map((m) => m.days_to_pay));
  return (
    <section aria-label={caption} className="grid gap-2">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-2 font-medium">
              Way of paying
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              Days to pay
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              Short
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Card fee
            </th>
          </tr>
        </thead>
        <tbody>
          {methods.map((m) => (
            <tr key={m.method} className="border-t">
              <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                <span className="block">{m.label}</span>
                <span className="block text-xs text-muted-foreground tabular">
                  {m.payments} {m.payments === 1 ? "payment" : "payments"}
                </span>
              </th>
              <td className="py-2.5 pr-2">
                <span className="flex items-center gap-2">
                  <span className="w-6 text-right tabular">{m.days_to_pay.toFixed(0)}</span>
                  <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
                    <span className={cn("block h-full rounded-full", m.method === "card" ? "bg-positive" : "bg-primary/70")} style={{ width: `${Math.max(4, (m.days_to_pay / slowest) * 100)}%` }} />
                  </span>
                </span>
              </td>
              <td className="py-2.5 pr-2 text-right">{m.short_minor ? <Money minor={m.short_minor} currency={currency} className="text-danger" /> : <span className="text-muted-foreground">–</span>}</td>
              <td className="py-2.5 text-right">
                <Money minor={m.card_fee_minor} currency={currency} />
                {m.card_fee_is_estimate && <span className="sr-only"> (estimate)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">{cardFeeNote(rate)} Days run from the invoice to the money arriving.</p>
    </section>
  );
}

/** The payment-costs details in the side panel. */
export function PaymentCosts({ detail }: { detail: PaymentCostsDetail }) {
  const currency = useCurrentUser().business.currency;
  return (
    <div className="grid gap-5">
      <MethodTable methods={detail.methods} rate={detail.card_rate} caption="How this customer pays" />
      {detail.leftovers.length > 0 && (
        <section aria-label="Left over after short payments" className="grid gap-2 text-sm">
          <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            Left over after short payments
            <InfoPopover label="About what's left over">We don't chase these: recording them as bank charges marks the invoices as paid.</InfoPopover>
          </h3>
          <ul className="divide-y rounded-lg border">
            {detail.leftovers.map((l) => (
              <li key={l.record_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>{l.reference ?? "Invoice"}</span>
                <Money minor={l.short_minor} currency={currency} className="font-medium" />
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="flex items-start gap-2 rounded-lg bg-primary-soft/60 px-3 py-2.5 text-sm">
        <CreditCardIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          {detail.tip}.{!detail.links_configured && " Payment links aren't set up yet, so reminders go out without one for now."}
        </span>
      </p>
    </div>
  );
}

/** The bank-charge next step: prepare it, open it while it waits, or say it is done. */
export function BankChargeStep({ rec, preparing, onPrepare, size, className }: { rec: Recommendation; preparing: boolean; onPrepare: () => void; size?: "sm" | "default"; className?: string }) {
  const can = useCan();
  const step = rec.next_step!;
  const status = step.action?.status;
  if (status === "executed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-positive">
        <ReceiptIcon className="size-4" aria-hidden /> Bank charge recorded
      </span>
    );
  }
  if (!can("reconcile")) return <span className="text-sm text-muted-foreground">{step.label}</span>;
  return (
    <Button size={size} className={cn("max-w-full", className)} onClick={onPrepare} disabled={preparing}>
      {preparing && <Loader2Icon className="animate-spin" aria-hidden />}
      <span className="truncate">{status === "pending" ? "Open the bank charge" : step.label}</span>
    </Button>
  );
}

/** The last 180 days at a glance: what short payments cost, what card could save, how much sooner card pays. */
export function GettingPaidSummary() {
  const query = useGettingPaid();
  const currency = useCurrentUser().business.currency;
  const d = query.data;
  if (!d || (!d.lost_to_short_minor && !d.left_to_record_minor && d.days_sooner_by_card === null)) return null;
  const rates = d.card_rate.source === "yours" ? `After card fees at your own rate (${d.card_rate.label})` : `After card fees at ${d.card_rate.label}, or ${d.card_rate_abroad.label}`;
  const items: StatItem[] = [
    {
      label: "Lost to short payments",
      value: <Money minor={d.lost_to_short_minor} currency={currency} />,
      note: `${d.short_payments} ${d.short_payments === 1 ? "payment" : "payments"}`,
      tone: d.lost_to_short_minor ? "danger" : "default",
    },
    ...(d.left_to_record_count > 0
      ? [{ label: "To record as bank charges", value: <Money minor={d.left_to_record_minor} currency={currency} />, note: `${d.left_to_record_count} ${d.left_to_record_count === 1 ? "invoice" : "invoices"}` }]
      : []),
    { label: "Could save by card", value: <Money minor={d.could_save_minor} currency={currency} />, note: "after card fees", tone: d.could_save_minor ? "positive" : "default" },
    {
      label: "Card pays sooner by",
      value: d.days_sooner_by_card === null ? "–" : `${d.days_sooner_by_card.toFixed(0)} days`,
      note: d.days_sooner_by_card === null ? "Not enough card payments yet" : undefined,
    },
  ];
  return (
    <section aria-label={`Getting paid, last ${d.days} days`}>
      <Disclosure summary={`Getting paid, last ${d.days} days`}>
        <div className="grid gap-4">
          <StatStrip items={items} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {!d.links_configured && (
              <span className="inline-flex items-start gap-1.5">
                <CreditCardIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                {d.links_problem ?? "Card payment links aren't set up yet, so reminders go out without one."}
              </span>
            )}
            <span className="inline-flex items-center">
              How we work these out
              <InfoPopover label="How we work these out" title="How we work these out">
                <p>{rates}.</p>
                {d.days_to_pay_by_transfer !== null && <p>Bank transfers take {d.days_to_pay_by_transfer.toFixed(0)} days on average.</p>}
              </InfoPopover>
            </span>
          </div>
        </div>
      </Disclosure>
    </section>
  );
}
