import { CircleCheckIcon, CircleIcon, FileDownIcon, LandmarkIcon, Loader2Icon, PencilIcon, SendIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useCashFlow, useFinancing, useFinancingQuote, useSaveProfile, useShareLenderPack, type FinancingAsk } from "@/api/hooks";
import type { Action, BusinessProfile, Financing, FinancingOption, OwnerField, ProfileField, QuoteResult } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Worded } from "@/components/AiText";
import { ChartCard } from "@/components/ChartCard";
import { ForecastEffectChart } from "@/components/charts";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, HeadlineSkeleton } from "@/components/skeletons";
import { EmptyState, FormError } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const selectClass = "h-10 w-full rounded-lg border border-input bg-card px-3 text-base shadow-card sm:text-sm";

export const CHOICE_LABELS: Record<string, string> = {
  sole_trader: "Sole trader",
  partnership: "Partnership",
  limited_company: "Limited company",
  poor: "Poor",
  fair: "Fair",
  good: "Good",
  excellent: "Excellent",
  cash_flow: "Cash flow",
  stock: "Stock",
  vehicle: "A vehicle",
  equipment: "Equipment",
  premises: "Premises",
  growth: "Growth",
  tax_bill: "A tax bill",
  other: "Something else",
};

const OWNER_LABELS: Record<OwnerField, string> = {
  industry: "Industry",
  business_type: "Type of business",
  assets: "Assets the business owns",
  credit_band: "Credit history",
  purpose: "What the money is for",
  country: "Country",
};
const OWNER_ORDER: OwnerField[] = ["industry", "business_type", "purpose", "credit_band", "assets", "country"];

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const pounds = (text: string) => {
  const n = Number(text.replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export default function FinancingPage() {
  const [ask, setAsk] = useState<FinancingAsk>({});
  const financing = useFinancing(ask);
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader title="Financing" description="Ways to cover a cash gap, compared by what they really cost. Information, not advice." />
      <QueryView
        query={financing}
        loading={
          <div className="grid gap-6" aria-busy="true">
            <HeadlineSkeleton />
            <CardsSkeleton />
          </div>
        }
        empty={<EmptyState icon={LandmarkIcon} title="No financing options yet" description="Options are matched to your forecast once your records are connected." />}
      >
        {(data) => <FinancingContent data={data} ask={ask} onAsk={setAsk} updating={financing.isFetching && financing.isPlaceholderData} />}
      </QueryView>
    </div>
  );
}

function FinancingContent({ data, ask, onAsk, updating }: { data: Financing; ask: FinancingAsk; onAsk: (a: FinancingAsk) => void; updating: boolean }) {
  const currency = useCurrentUser().business.currency;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data.options.find((o) => o.id === selectedId) ?? null;
  const eligible = data.options.filter((o) => o.eligible);
  const nearMisses = data.options.filter((o) => !o.eligible);

  return (
    <>
      <GapHeadline data={data} currency={currency} />
      <div className="max-w-3xl">
        <Worded wording={data.summary} />
      </div>
      <NeedForm data={data} ask={ask} onAsk={onAsk} updating={updating} />

      <section aria-labelledby="options-heading" className="grid gap-3">
        <h2 id="options-heading" className="text-sm font-medium">
          Options you can use <span className="font-normal text-muted-foreground">· free first, then by what they cost</span>
        </h2>
        {eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground">None of the options fit your business right now. The ones below say what would change that.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {eligible.map((o) => (
              <li key={o.id} className="min-w-0">
                <OptionCard option={o} need={data.need.amount_minor} currency={currency} selected={o.id === selectedId} onSelect={() => setSelectedId(o.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {nearMisses.length > 0 && (
        <section aria-labelledby="near-heading" className="grid gap-3">
          <h2 id="near-heading" className="text-sm font-medium">
            Not available yet
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {nearMisses.map((o) => (
              <li key={o.id} className="min-w-0 rounded-xl border border-dashed p-4">
                <div className="text-xs text-muted-foreground">{o.provider}</div>
                <h3 className="text-sm font-semibold">{o.product}</h3>
                <ul className="mt-2 grid gap-1">
                  {o.reasons.map((r) => (
                    <li key={r} className="flex gap-1.5 text-xs">
                      <StatusDot status="warning" label="Not yet" />
                      {r}
                    </li>
                  ))}
                </ul>
                <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => setSelectedId(o.id)}>
                  See what it would cost
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Readiness data={data} />
        <LenderPack data={data} />
      </div>
      <Profile profile={data.profile} currency={currency} />
      <p className="max-w-3xl text-xs text-muted-foreground">{data.disclaimer}</p>

      <SidePanel open={selected !== null} onOpenChange={(o) => !o && setSelectedId(null)} title={selected?.product ?? ""} description={selected?.provider}>
        {selected && <OptionPlanner key={selected.id} option={selected} need={data.need} safetyLevelMinor={data.safety_level_minor} currency={currency} />}
      </SidePanel>
    </>
  );
}

function GapHeadline({ data, currency }: { data: Financing; currency: string }) {
  const g = data.gap;
  if (data.need.source === "you" && data.need.amount_minor) {
    return (
      <Headline
        label="You're looking for"
        value={<Money minor={data.need.amount_minor} currency={currency} />}
        note={data.need.months ? `Over ${data.need.months} months` : "Options are costed for this amount"}
      />
    );
  }
  if (!g) {
    return (
      <Headline label="Cash gap to cover" value="None forecast" note={<StatusDot status="positive" label="Cash stays above your safety level for the next 90 days" showLabel />} />
    );
  }
  return (
    <Headline
      label="Cash gap to cover"
      value={<Money minor={g.safety_level_minor - g.lowest_minor} currency={currency} />}
      note={
        <>
          Below your safety level of <Money minor={g.safety_level_minor} currency={currency} /> from {formatDate(g.starts_on, true)} for about {g.days} days, lowest on{" "}
          {formatDate(g.lowest_on)}. We cost each option for <Money minor={g.amount_minor} currency={currency} />, the gap plus 5% for what borrowing costs.
        </>
      }
    />
  );
}

/** Compare for an amount and purpose the owner chooses, instead of the forecast's gap. */
function NeedForm({ data, ask, onAsk, updating }: { data: Financing; ask: FinancingAsk; onAsk: (a: FinancingAsk) => void; updating: boolean }) {
  const [amount, setAmount] = useState(ask.amount_minor ? String(ask.amount_minor / 100) : "");
  const [months, setMonths] = useState(ask.months ? String(ask.months) : "");
  const [purpose, setPurpose] = useState(ask.purpose ?? "");
  const [error, setError] = useState<string | null>(null);
  const custom = Boolean(ask.amount_minor || ask.purpose || ask.months);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = amount.trim() ? pounds(amount) : undefined;
    const m = months.trim() ? Number(months) : undefined;
    if (a === null) return setError("Enter an amount in pounds, such as 18000.");
    if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 120)) return setError("Choose between 1 and 120 months.");
    setError(null);
    onAsk({ ...(a ? { amount_minor: a } : {}), ...(m ? { months: m } : {}), ...(purpose ? { purpose } : {}) });
  };
  const reset = () => {
    setAmount("");
    setMonths("");
    setPurpose("");
    setError(null);
    onAsk({});
  };

  return (
    <form onSubmit={submit} aria-label="Compare for a different amount" className="grid gap-3 rounded-xl border bg-card p-4 shadow-card">
      <p className="text-sm font-medium">{custom ? "Comparing for your own amount" : "Compare for a planned cost instead"}</p>
      <div className="grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[1fr_8rem_1fr_auto]">
        <div className="grid gap-1.5">
          <Label htmlFor="need-amount">Amount (£)</Label>
          <Input id="need-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 18000" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="need-months">Months</Label>
          <Input id="need-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} placeholder="Any" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="need-purpose">For</Label>
          <select id="need-purpose" className={selectClass} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">Any purpose</option>
            {data.profile.choices.purpose.map((p) => (
              <option key={p} value={p}>
                {CHOICE_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={updating}>
            {updating && <Loader2Icon className="animate-spin" aria-hidden />} Compare
          </Button>
          {custom && (
            <Button type="button" variant="ghost" onClick={reset}>
              Use the forecast
            </Button>
          )}
        </div>
      </div>
      <FormError message={error} />
    </form>
  );
}

function OptionCard({ option: o, need, currency, selected, onSelect }: { option: FinancingOption; need: number | null; currency: string; selected: boolean; onSelect: () => void }) {
  const q = o.quote;
  return (
    <article aria-labelledby={`opt-${o.id}`} className={cn("flex h-full flex-col rounded-xl border bg-card shadow-card", selected && "ring-2 ring-primary/50")}>
      <div className="flex-1 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{o.provider}</div>
            <h3 id={`opt-${o.id}`} className="font-semibold">
              {o.product}
            </h3>
          </div>
          {o.free && <Badge variant="positive">Free</Badge>}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{o.about}</p>
        {q ? (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Total cost</dt>
              <dd className="font-semibold">
                <Money minor={q.total_cost_minor} currency={currency} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">A month</dt>
              <dd className="font-semibold">{q.monthly_repayment_minor ? <Money minor={q.monthly_repayment_minor} currency={currency} /> : "Nothing"}</dd>
            </div>
            <div className="col-span-2 flex items-start gap-1.5 text-xs">
              <StatusDot status={q.closes_gap ? "positive" : "warning"} label={q.closes_gap ? "Keeps cash above the safety level" : "Cash still dips below the safety level"} />
              <span>
                {q.closes_gap ? "Keeps cash above your safety level" : "Cash still dips below your safety level"}
                {!q.covers_need && need ? (
                  <>
                    {" "}
                    (gives up to <Money minor={q.amount_minor} currency={currency} /> of <Money minor={need} currency={currency} />)
                  </>
                ) : null}
              </span>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm">
            Up to <Money minor={o.limit_minor} currency={currency} />, {o.min_months === o.max_months ? `${o.min_months} months` : `${o.min_months} to ${o.max_months} months`}
          </p>
        )}
      </div>
      <div className="border-t px-5 py-3">
        <Button variant={selected ? "default" : "secondary"} size="sm" onClick={onSelect} aria-pressed={selected}>
          Try amounts and lengths
        </Button>
      </div>
    </article>
  );
}

function OptionPlanner({ option: o, need, safetyLevelMinor, currency }: { option: FinancingOption; need: Financing["need"]; safetyLevelMinor: number; currency: string }) {
  const top = Math.max(o.limit_minor, o.min_minor);
  const step = top - o.min_minor >= 1_000_00 ? 100_00 : 10_00;
  const clamp = (v: number) => Math.min(top, Math.max(o.min_minor, v));
  const [amount, setAmount] = useState(() => clamp(o.quote?.amount_minor ?? need.amount_minor ?? o.min_minor));
  const [months, setMonths] = useState(() => Math.min(o.max_months, Math.max(o.min_months, o.quote?.months ?? need.months ?? o.min_months)));
  const input = useDebounced({ option_id: o.id, amount_minor: amount, months });
  const quote = useFinancingQuote(input);
  const base = useCashFlow();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {!o.eligible && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft/50 p-3 text-sm">
          <p className="font-medium">You can't use this yet</p>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {o.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-5">
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <Money minor={amount} currency={currency} className="font-medium" />
          </div>
          <Slider min={o.min_minor} max={top} step={step} value={[amount]} onValueChange={([v]) => v !== undefined && setAmount(v)} disabled={top === o.min_minor} aria-label="Amount" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <Money minor={o.min_minor} currency={currency} />
            <span>
              up to <Money minor={top} currency={currency} />
            </span>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Length</span>
            <span className="font-medium tabular">{months === 1 ? "1 month" : `${months} months`}</span>
          </div>
          <Slider
            min={o.min_months}
            max={o.max_months}
            step={1}
            value={[months]}
            onValueChange={([v]) => v !== undefined && setMonths(v)}
            disabled={o.min_months === o.max_months}
            aria-label="Length in months"
          />
        </div>
      </div>
      <div aria-live="polite" className="grid gap-4">
        {quote.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden /> Working out the cost…
          </p>
        ) : quote.isError ? (
          <FormError message={errorMessage(quote.error)} />
        ) : quote.data ? (
          <QuoteView q={quote.data} without={base.data?.series} safetyLevelMinor={safetyLevelMinor} currency={currency} stale={quote.isFetching} />
        ) : (
          <p className="text-sm text-muted-foreground">We couldn't cost this option.</p>
        )}
      </div>
    </div>
  );
}

function QuoteView({ q, without, safetyLevelMinor, currency, stale }: { q: QuoteResult; without?: { date: string; expected_minor: number }[]; safetyLevelMinor: number; currency: string; stale: boolean }) {
  const weekly = q.series.filter((_, i) => i % 7 === 0);
  const before = new Map((without ?? []).map((p) => [p.date, p.expected_minor]));
  return (
    <div className={cn("grid gap-4 transition-opacity", stale && "opacity-60")}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-sm text-muted-foreground">Total cost</div>
          <div className="text-2xl font-semibold">
            <Money minor={q.total_cost_minor} currency={currency} />
          </div>
          {q.cost_range_minor[0] !== q.cost_range_minor[1] && (
            <div className="text-xs text-muted-foreground">
              <Money minor={q.cost_range_minor[0]} currency={currency} /> to <Money minor={q.cost_range_minor[1]} currency={currency} /> across the rate range
            </div>
          )}
        </div>
        <div>
          <div className="text-sm text-muted-foreground">A month</div>
          <div className="text-2xl font-semibold">{q.monthly_repayment_minor ? <Money minor={q.monthly_repayment_minor} currency={currency} /> : "Nothing"}</div>
          {q.yearly_cost_pct !== null && <div className="text-xs text-muted-foreground">About {q.yearly_cost_pct}% a year</div>}
        </div>
      </div>
      {q.fee_minor > 0 && (
        <p className="text-xs text-muted-foreground">
          Includes a fee of <Money minor={q.fee_minor} currency={currency} />.
        </p>
      )}
      <p className="flex items-start gap-2 text-sm">
        <StatusDot status={q.closes_gap ? "positive" : "warning"} label={q.closes_gap ? "Closes the gap" : "Doesn't close the gap"} />
        {q.forecast_effect}
      </p>
      <ChartCard
        title="Cash with this option"
        summary={q.forecast_effect}
        className="shadow-none"
        table={{
          columns: [
            { key: "date", label: "Week of" },
            { key: "with", label: "With this", numeric: true },
            { key: "without", label: "Without", numeric: true },
          ],
          rows: weekly.map((p) => ({
            id: p.date,
            date: formatDate(p.date, true),
            with: <Money minor={p.expected_minor} currency={currency} />,
            without: before.has(p.date) ? <Money minor={before.get(p.date)!} currency={currency} /> : "–",
          })),
        }}
      >
        <ForecastEffectChart series={q.series} without={without} safetyLevelMinor={safetyLevelMinor} currency={currency} height={200} />
      </ChartCard>
    </div>
  );
}

function Readiness({ data }: { data: Financing }) {
  const done = data.readiness.filter((r) => r.ok).length;
  return (
    <section aria-labelledby="readiness-heading" className="rounded-xl border bg-card shadow-card">
      <header className="flex items-baseline justify-between gap-2 px-5 pt-4">
        <h2 id="readiness-heading" className="text-sm font-medium">
          What a lender looks at
        </h2>
        <span className="text-xs text-muted-foreground tabular">
          {done} of {data.readiness.length} ready
        </span>
      </header>
      <ul className="grid gap-3 px-5 pb-5 pt-3">
        {data.readiness.map((r) => (
          <li key={r.id} className="flex gap-2.5 text-sm">
            {r.ok ? (
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Ready" />
            ) : (
              <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not yet" />
            )}
            <div className="min-w-0">
              <p>
                {r.label}: <span className="text-muted-foreground">{r.value}</span>
              </p>
              {!r.ok && r.tip && <p className="text-xs text-muted-foreground">{r.tip}</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">This is not a credit score. Lenders decide on their own terms.</p>
    </section>
  );
}

function LenderPack({ data }: { data: Financing }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="pack-heading" className="flex flex-col rounded-xl border bg-card shadow-card">
      <div className="flex-1 px-5 pt-4">
        <h2 id="pack-heading" className="text-sm font-medium">
          Lender pack
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A PDF with your business profile, 12 months of profit and loss, unpaid invoices, the cash forecast and the checklist. {data.lender_pack.approver} We never apply
          for anything on your behalf.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 px-5 pb-5 pt-4">
        <Button asChild variant="secondary">
          <a href="/api/lender-pack.pdf" download>
            <FileDownIcon aria-hidden /> Download PDF
          </a>
        </Button>
        {data.lender_pack.can_share && (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            <SendIcon aria-hidden /> Share with a lender
          </Button>
        )}
      </div>
      <SidePanel open={open} onOpenChange={setOpen} title="Share the lender pack" description="A business owner approves before anything is sent.">
        <ShareForm onDone={() => setOpen(false)} />
      </SidePanel>
    </section>
  );
}

function ShareForm({ onDone }: { onDone: () => void }) {
  const share = useShareLenderPack();
  const [lender, setLender] = useState("");
  const [email, setEmail] = useState("");
  const [action, setAction] = useState<Action | null>(null);

  if (action) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">The pack is prepared. Exactly this PDF is emailed once a business owner approves.</p>
        <ActionConfirmation confirmation={action} onDone={onDone} />
      </div>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    share.mutate({ lender_name: lender.trim(), email: email.trim() }, { onSuccess: (r) => setAction(r.action) });
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="lender-name">Lender</Label>
        <Input id="lender-name" required maxLength={120} value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Northgate Bank" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="lender-email">Their email</Label>
        <Input id="lender-email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <FormError message={share.isError ? errorMessage(share.error) : null} />
      <div>
        <Button type="submit" disabled={share.isPending || !lender.trim() || !email.trim()}>
          {share.isPending && <Loader2Icon className="animate-spin" aria-hidden />} Prepare and ask for approval
        </Button>
      </div>
    </form>
  );
}

// ── Business profile ───────────────────────────────────────────────────────

type Kind = "money" | "share" | "pct" | "months" | "days";
function kindOf(field: string): Kind {
  if (field.endsWith("_minor")) return "money";
  if (field.endsWith("_share")) return "share";
  if (field.endsWith("_pct")) return "pct";
  if (field === "months_trading") return "months";
  return "days";
}

function ProfileValue({ field, value, currency }: { field: string; value: number | null; currency: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">Not known</span>;
  switch (kindOf(field)) {
    case "money":
      return <Money minor={value} currency={currency} />;
    case "share":
      return <span className="tabular">{Math.round(value * 100)}%</span>;
    case "pct":
      return <span className="tabular">{`${value > 0 ? "+" : ""}${value.toFixed(1)}%`}</span>;
    case "months":
      return <span className="tabular">{value === 1 ? "1 month" : `${value} months`}</span>;
    default:
      return <span className="tabular">{`${Math.round(value)} days`}</span>;
  }
}

/** What a person types in the form, in pounds or percent, from the stored value, and back. */
const toInput = (field: string, v: number | null) => {
  if (v === null || v === undefined) return "";
  const k = kindOf(field);
  return String(k === "money" ? v / 100 : k === "share" ? Math.round(v * 1000) / 10 : v);
};
const fromInput = (field: string, text: string): number | null => {
  const n = Number(text.replace(/[£,%\s]/g, ""));
  if (!text.trim() || !Number.isFinite(n)) return null;
  const k = kindOf(field);
  return k === "money" ? Math.round(n * 100) : k === "share" ? n / 100 : k === "months" ? Math.round(n) : n;
};

function Profile({ profile, currency }: { profile: BusinessProfile; currency: string }) {
  const can = useCan();
  const me = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const owner = profile.owner_fields;
  return (
    <section aria-labelledby="profile-heading" className="rounded-xl border bg-card shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <div>
          <h2 id="profile-heading" className="text-sm font-medium">
            Business profile
          </h2>
          <p className="text-xs text-muted-foreground">Worked out from your records. Corrections are shown next to the automatic value.</p>
        </div>
        {can("edit_profile") ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden /> Edit profile
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Only a business owner can change the profile.</span>
        )}
      </header>
      <dl className="grid gap-x-8 px-5 pb-5 pt-3 sm:grid-cols-2">
        {OWNER_ORDER.map((k) => (
          <ProfileRow key={k} label={OWNER_LABELS[k]}>
            {owner[k] ? CHOICE_LABELS[owner[k]] ?? owner[k] : <span className="text-muted-foreground">Not added</span>}
          </ProfileRow>
        ))}
        {profile.fields.map((f) => (
          <ProfileRow
            key={f.field}
            label={f.label}
            note={
              f.corrected ? (
                <>
                  Corrected{f.corrected_by === me.user.id ? " by you" : ""}
                  {f.corrected_at ? ` on ${formatDateTime(f.corrected_at)}` : ""}. Automatic: <ProfileValue field={f.field} value={f.auto} currency={currency} />
                </>
              ) : null
            }
          >
            <ProfileValue field={f.field} value={f.value} currency={currency} />
            {f.corrected && (
              <Badge variant="accent" className="ml-2">
                Corrected
              </Badge>
            )}
          </ProfileRow>
        ))}
      </dl>
      <SidePanel open={editing} onOpenChange={setEditing} title="Edit business profile" description="Lenders ask for these. Corrections replace the automatic value until you put it back.">
        <ProfileForm profile={profile} onDone={() => setEditing(false)} />
      </SidePanel>
    </section>
  );
}

function ProfileRow({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b py-2.5 text-sm last:border-0 sm:[&:nth-last-child(2)]:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center font-medium">{children}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

function ProfileForm({ profile, onDone }: { profile: BusinessProfile; onDone: () => void }) {
  const save = useSaveProfile();
  const currency = useCurrentUser().business.currency;
  const [owner, setOwner] = useState<Record<OwnerField, string>>(() => {
    const o = {} as Record<OwnerField, string>;
    for (const k of OWNER_ORDER) o[k] = profile.owner_fields[k] ?? "";
    return o;
  });
  // A correction per automatic field: the text typed, or null to use the automatic value
  const [corr, setCorr] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(profile.fields.map((f) => [f.field, f.corrected ? toInput(f.field, f.value) : null])),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const owner_fields: Partial<Record<OwnerField, string | null>> = {};
    for (const k of OWNER_ORDER) if ((profile.owner_fields[k] ?? "") !== owner[k]) owner_fields[k] = owner[k] || null;
    const overrides: Record<string, number | null> = {};
    for (const f of profile.fields) {
      const text = corr[f.field];
      if (text === null || text === undefined) {
        if (f.corrected) overrides[f.field] = null;
        continue;
      }
      const v = fromInput(f.field, text);
      if (v === null) return setError(`Enter a number for "${f.label}", or use the automatic value.`);
      if (!f.corrected || v !== f.value) overrides[f.field] = v;
    }
    setError(null);
    save.mutate(
      { owner_fields, overrides },
      {
        onSuccess: () => {
          toast.success("Profile saved. Options and the checklist are updated.");
          onDone();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-6">
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-medium">What only you know</legend>
        {OWNER_ORDER.map((k) => {
          const choices = (profile.choices as Record<string, string[] | undefined>)[k];
          return (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={`owner-${k}`}>{OWNER_LABELS[k]}</Label>
              {choices ? (
                <select id={`owner-${k}`} className={selectClass} value={owner[k]} onChange={(e) => setOwner((o) => ({ ...o, [k]: e.target.value }))}>
                  <option value="">Not added</option>
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {CHOICE_LABELS[c] ?? c}
                    </option>
                  ))}
                </select>
              ) : (
                <Input id={`owner-${k}`} maxLength={k === "country" ? 2 : 120} value={owner[k]} onChange={(e) => setOwner((o) => ({ ...o, [k]: e.target.value }))} />
              )}
            </div>
          );
        })}
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-medium">Correct an automatic value</legend>
        {profile.fields.map((f) => (
          <CorrectionField key={f.field} field={f} currency={currency} value={corr[f.field] ?? null} onChange={(v) => setCorr((c) => ({ ...c, [f.field]: v }))} />
        ))}
      </fieldset>
      <FormError message={error} />
      <div className="sticky bottom-0 -mx-5 border-t bg-card px-5 py-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2Icon className="animate-spin" aria-hidden />} Save profile
        </Button>
      </div>
    </form>
  );
}

const UNITS: Record<Kind, string> = { money: "£", share: "%", pct: "%", months: "months", days: "days" };

function CorrectionField({ field: f, value, onChange, currency }: { field: ProfileField; value: string | null; onChange: (v: string | null) => void; currency: string }) {
  const id = `corr-${f.field}`;
  const unit = UNITS[kindOf(f.field)];
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={value === null ? undefined : id}>
        {f.label} <span className="font-normal text-muted-foreground">({unit})</span>
      </Label>
      {value === null ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            Automatic: <ProfileValue field={f.field} value={f.auto} currency={currency} />
          </span>
          <Button type="button" variant="ghost" size="sm" aria-label={`Correct ${f.label}`} onClick={() => onChange(toInput(f.field, f.auto))}>
            Correct
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />
          <Button type="button" variant="ghost" size="sm" aria-label={`Use the automatic ${f.label.toLowerCase()}`} onClick={() => onChange(null)}>
            Use automatic
          </Button>
        </div>
      )}
    </div>
  );
}
