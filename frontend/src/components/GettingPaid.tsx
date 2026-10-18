import { BanknoteIcon, CreditCardIcon, Loader2Icon, ReceiptIcon } from "lucide-react";
import { useCurrentUser, useCan } from "@/api/auth";
import { useGettingPaid } from "@/api/hooks";
import type { CardRate, GettingPaidDetail, PaymentCostsDetail, PaymentMethodRow, Recommendation, ReminderDetail } from "@/api/types";
import { Money } from "@/components/Money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

/*
 * Getting paid on recommendation cards: the reminder step and the invoices it covers, whether it
 * carries a payment link, how each way of paying compares, and recording what arrived short.
 */

export const isReminder = (d: GettingPaidDetail | null | undefined): d is ReminderDetail => Boolean(d && "reminder" in d);
export const isPaymentCosts = (d: GettingPaidDetail | null | undefined): d is PaymentCostsDetail => Boolean(d && "methods" in d);

const LINK_TEXT = {
  all: "Includes a link to pay online by card, made only once the reminder is approved.",
  some: "Some of these invoices get a link to pay online by card, made only once the reminder is approved.",
  none: "No card payment link: payment links aren't set up yet. Add a payment link key to include one.",
} as const;

/** "Reminder 2 of 3" on the card, and who approves a final notice. */
export function ReminderChip({ rec }: { rec: Recommendation }) {
  const d = rec.getting_paid;
  if (!isReminder(d)) return null;
  const r = d.reminder;
  return (
    <>
      <Badge variant={r.stage === r.of ? "warning" : "accent"}>
        Reminder {r.stage} of {r.of}
      </Badge>
      {r.owner_only && <Badge variant="outline">A business owner approves</Badge>}
    </>
  );
}

/** The invoices a reminder covers and whether it carries a payment link. */
export function ReminderInvoices({ detail }: { detail: ReminderDetail }) {
  const currency = useCurrentUser().business.currency;
  const r = detail.reminder;
  return (
    <section aria-label="Invoices in this reminder" className="grid gap-2 text-sm">
      <ul className="grid gap-1">
        {r.invoices.map((i) => (
          <li key={i.record_id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{i.reference ?? "Invoice"}</span>
            <Money minor={i.open_minor} currency={currency} />
            <span className="text-muted-foreground">
              due {formatDate(i.due, true)}, {i.days_overdue} {i.days_overdue === 1 ? "day" : "days"} overdue
            </span>
          </li>
        ))}
      </ul>
      {r.previous.length > 0 && (
        <p className="text-muted-foreground">
          Sent before: {r.previous.map((p) => `reminder ${p.stage} on ${formatDate(p.sent_on, true)}`).join(", ")}.
        </p>
      )}
      <p className="flex items-start gap-1.5 text-muted-foreground">
        <CreditCardIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        {LINK_TEXT[r.link]}
      </p>
    </section>
  );
}

const cardFeeNote = (rate: CardRate) =>
  rate.source === "yours" ? `Card fees at your own rate (${rate.label}).` : `Card fees are an estimate at ${rate.label}, as you have too few card payments of your own.`;

/** How each way of paying compares: what arrived short, what card costs, and days to get paid. */
export function MethodTable({ methods, rate, caption }: { methods: PaymentMethodRow[]; rate: CardRate; caption: string }) {
  const currency = useCurrentUser().business.currency;
  return (
    <section aria-label={caption} className="grid gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-2 font-medium">
                Way of paying
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                Payments
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                Arrived short
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                Card fee
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Days to pay
              </th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.method} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-2 text-left font-normal">
                  {m.label}
                </th>
                <td className="py-2 pr-2 text-right tabular">{m.payments}</td>
                <td className="py-2 pr-2 text-right">{m.short_minor ? <Money minor={m.short_minor} currency={currency} /> : <span className="text-muted-foreground">–</span>}</td>
                <td className="py-2 pr-2 text-right">
                  <Money minor={m.card_fee_minor} currency={currency} />
                  {m.card_fee_is_estimate && <span className="sr-only"> (estimate)</span>}
                </td>
                <td className="py-2 text-right tabular">{m.days_to_pay.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{cardFeeNote(rate)} Days to pay run from the invoice date to the day the money arrived.</p>
    </section>
  );
}

/** The payment-costs details in the side panel. */
export function PaymentCosts({ detail }: { detail: PaymentCostsDetail }) {
  const currency = useCurrentUser().business.currency;
  return (
    <div className="grid gap-4">
      <MethodTable methods={detail.methods} rate={detail.card_rate} caption="How this customer pays" />
      {detail.leftovers.length > 0 && (
        <section aria-label="Left over after short payments" className="grid gap-1 text-sm">
          <h3 className="text-sm font-medium">Left over after short payments</h3>
          <ul className="grid gap-1">
            {detail.leftovers.map((l) => (
              <li key={l.record_id} className="flex gap-2">
                <span>{l.reference ?? "Invoice"}</span>
                <Money minor={l.short_minor} currency={currency} />
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">We don't chase these: recording them as bank charges marks the invoices as paid.</p>
        </section>
      )}
      <p className="flex items-start gap-1.5 text-sm">
        <CreditCardIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {detail.tip}.{!detail.links_configured && " Payment links aren't set up yet, so reminders go out without one for now."}
        </span>
      </p>
    </div>
  );
}

/** The bank-charge next step: prepare it, open it while it waits, or say it is done. */
export function BankChargeStep({ rec, preparing, onPrepare }: { rec: Recommendation; preparing: boolean; onPrepare: () => void }) {
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
    <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left" onClick={onPrepare} disabled={preparing}>
      {preparing && <Loader2Icon className="animate-spin" aria-hidden />}
      {status === "pending" ? "Open the bank charge" : step.label}
    </Button>
  );
}

/** The last 180 days at a glance: what short payments cost, what card could save, how much sooner card pays. */
export function GettingPaidSummary() {
  const query = useGettingPaid();
  const currency = useCurrentUser().business.currency;
  const d = query.data;
  if (!d || (!d.lost_to_short_minor && !d.left_to_record_minor && d.days_sooner_by_card === null)) return null;
  return (
    <section aria-labelledby="getting-paid-heading" className="grid gap-3 rounded-xl border bg-card p-4 shadow-card">
      <h2 id="getting-paid-heading" className="flex items-center gap-2 text-sm font-semibold">
        <BanknoteIcon className="size-4 text-muted-foreground" aria-hidden /> Getting paid, last {d.days} days
      </h2>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Lost to payments arriving short</dt>
          <dd className="text-lg font-semibold">
            <Money minor={d.lost_to_short_minor} currency={currency} />
          </dd>
          <dd className="text-xs text-muted-foreground">
            {d.short_payments} {d.short_payments === 1 ? "payment" : "payments"}
            {d.left_to_record_count > 0 && (
              <>
                , <Money minor={d.left_to_record_minor} currency={currency} /> still to record as bank charges
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Could save if those customers paid by card</dt>
          <dd className="text-lg font-semibold">
            <Money minor={d.could_save_minor} currency={currency} />
          </dd>
          <dd className="text-xs text-muted-foreground">
            {d.card_rate.source === "yours" ? `After card fees at your own rate (${d.card_rate.label})` : `After card fees at ${d.card_rate.label}, or ${d.card_rate_abroad.label}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Card payments arrive sooner by</dt>
          <dd className="text-lg font-semibold">{d.days_sooner_by_card === null ? "Not enough card payments yet" : `${d.days_sooner_by_card.toFixed(0)} days`}</dd>
          {d.days_to_pay_by_transfer !== null && <dd className="text-xs text-muted-foreground">Bank transfers take {d.days_to_pay_by_transfer.toFixed(0)} days on average</dd>}
        </div>
      </dl>
      {!d.links_configured && (
        <p className="text-xs text-muted-foreground">
          {d.links_problem ?? "Card payment links aren't set up yet, so reminders go out without one. Add a payment link key to include them."}
        </p>
      )}
    </section>
  );
}
