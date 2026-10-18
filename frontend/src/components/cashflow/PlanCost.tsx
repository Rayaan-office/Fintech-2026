import { XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useCan } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useAddPlan, usePlannedItems, useRemovePlan } from "@/api/hooks";
import type { PlannedCost, PlanRepeat } from "@/api/types";
import { Money } from "@/components/Money";
import { FormError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addDays, formatDate } from "@/lib/format";
import { fractionDigits } from "@/lib/money";

const selectClass = "h-10 w-full rounded-lg border border-input bg-card px-3 text-base shadow-card sm:text-sm";
const MAX_MINOR = 100_000_000_00; // the server's limit: anything larger is a typing mistake

const REPEATS: Record<PlanRepeat, string> = { none: "Just once", weekly: "Every week", monthly: "Every month" };

export function PlanForm({ currency, today, end, onAdd }: { currency: string; today: string; end: string; onAdd: (p: PlannedCost) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [repeat, setRepeat] = useState<PlanRepeat>("none");
  const parsed = Number(amount.replace(/[,£$€\s]/g, ""));
  const minor = Number.isFinite(parsed) ? Math.round(parsed * 10 ** fractionDigits(currency)) : NaN;
  const first = addDays(today, 1);
  const last = addDays(today, 365);
  const dateOk = date !== "" && date >= first && date <= last;
  const valid = label.trim() !== "" && minor > 0 && minor <= MAX_MINOR && dateOk;

  const problem =
    amount !== "" && !(minor > 0)
      ? "Enter the amount as a number, such as 12,000."
      : minor > MAX_MINOR
        ? "That amount looks too large. Check the number."
        : date !== "" && !dateOk
          ? `Pick a date between ${formatDate(first, true)} and ${formatDate(last, true)}.`
          : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd({ label: label.trim(), amount_minor: minor, date, repeat, direction: "out" });
    setLabel("");
    setAmount("");
    setDate("");
    setRepeat("none");
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="plan-label">What is it?</Label>
        <Input id="plan-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New van" maxLength={120} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="plan-amount">Amount</Label>
        <Input id="plan-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12,000" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="plan-date">When</Label>
          <Input id="plan-date" type="date" min={first} max={last} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="plan-repeat">How often</Label>
          <select id="plan-repeat" className={selectClass} value={repeat} onChange={(e) => setRepeat(e.target.value as PlanRepeat)}>
            {(Object.keys(REPEATS) as PlanRepeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEATS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {dateOk && date > end && <p className="text-xs text-muted-foreground">That's after the 90 days we forecast, so the chart won't change{repeat === "none" ? "" : " until it repeats inside them"}.</p>}
      <FormError message={problem} />
      <Button type="submit" disabled={!valid}>
        Try it in the forecast
      </Button>
      {!valid && !problem && <p className="text-xs text-muted-foreground">Fill in what it is, the amount and the date to try it.</p>}
    </form>
  );
}

export function TriedPlans({ plans, currency, onRemove }: { plans: PlannedCost[]; currency: string; onRemove: (i: number) => void }) {
  const can = useCan();
  const add = useAddPlan();
  if (plans.length === 0) return null;
  return (
    <section aria-labelledby="tried-heading" className="mt-6 grid gap-2">
      <h3 id="tried-heading" className="text-sm font-medium">
        Trying out <span className="font-normal text-muted-foreground">· only you see these</span>
      </h3>
      <ul className="grid gap-2 text-sm">
        {plans.map((p, i) => (
          <li key={`${p.label}-${p.date}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1">
              {p.label} · {formatDate(p.date)}
              {p.repeat && p.repeat !== "none" && <span className="text-muted-foreground"> · {REPEATS[p.repeat].toLowerCase()}</span>}
            </span>
            <Money minor={p.amount_minor} currency={currency} direction="out" />
            {can("use_financing") && (
              <Button
                size="sm"
                variant="secondary"
                disabled={add.isPending}
                onClick={() =>
                  add.mutate(p, {
                    onSuccess: () => {
                      onRemove(i);
                      toast(`${p.label} is now in the forecast for everyone in the business.`);
                    },
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              >
                Keep in forecast
              </Button>
            )}
            <Button size="icon" variant="ghost" className="size-8" aria-label={`Stop trying ${p.label}`} onClick={() => onRemove(i)}>
              <XIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function KeptPlans({ currency }: { currency: string }) {
  const can = useCan();
  const kept = usePlannedItems();
  const remove = useRemovePlan();
  const items = kept.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="kept-heading" className="mt-6 grid gap-2">
      <h3 id="kept-heading" className="text-sm font-medium">
        Kept in the forecast
      </h3>
      <ul className="grid gap-2 text-sm">
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1">
              {p.label} · {formatDate(p.date)}
              {p.repeat !== "none" && <span className="text-muted-foreground"> · {REPEATS[p.repeat].toLowerCase()}</span>}
            </span>
            <Money minor={p.amount_minor} currency={currency} direction={p.direction === "in" ? "in" : "out"} />
            {can("use_financing") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.id, { onSuccess: () => toast(`Removed ${p.label} from the forecast.`), onError: (err) => toast.error(errorMessage(err)) })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
