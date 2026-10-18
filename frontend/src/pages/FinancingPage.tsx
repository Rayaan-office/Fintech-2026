import { CircleCheckIcon, CircleIcon, FileTextIcon, LandmarkIcon, Loader2Icon, PlusIcon, StoreIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useCurrentUser } from "@/api/auth";
import { useCashFlow, useFinancing, type FinancingAsk } from "@/api/hooks";
import type { Financing } from "@/api/types";
import { Worded } from "@/components/AiText";
import { GapPicture } from "@/components/financing/GapChart";
import { LenderPackPanel } from "@/components/financing/LenderPack";
import { OptionPlanner } from "@/components/financing/OptionPanel";
import { NotYet, OptionsTable } from "@/components/financing/OptionsTable";
import { CHOICE_LABELS, ProfilePanel, selectClass } from "@/components/financing/Profile";
import { Disclosure, InfoPopover, Meter, Section } from "@/components/kit";
import { Money } from "@/components/Money";
import { Headline, PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton, HeadlineSkeleton } from "@/components/skeletons";
import { EmptyState, FormError } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const pounds = (text: string) => {
  const n = Number(text.replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export default function FinancingPage() {
  const [ask, setAsk] = useState<FinancingAsk>({});
  const financing = useFinancing(ask);
  return (
    <div className="grid grid-cols-1 gap-8">
      <PageHeader title="Financing" />
      <QueryView
        query={financing}
        loading={
          <div className="grid gap-8" aria-busy="true">
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

type Panel = { kind: "option"; id: string } | { kind: "pack" } | { kind: "profile" } | null;

function FinancingContent({ data, ask, onAsk, updating }: { data: Financing; ask: FinancingAsk; onAsk: (a: FinancingAsk) => void; updating: boolean }) {
  const currency = useCurrentUser().business.currency;
  const [panel, setPanel] = useState<Panel>(null);
  const selectedId = panel?.kind === "option" ? panel.id : null;
  const selected = data.options.find((o) => o.id === selectedId) ?? null;
  const eligible = data.options.filter((o) => o.eligible);
  const notYet = data.options.filter((o) => !o.eligible);
  const open = (id: string) => setPanel({ kind: "option", id });
  const close = (o: boolean) => !o && setPanel(null);

  return (
    <>
      <GapHeadline data={data} currency={currency} ask={ask} onAsk={onAsk} updating={updating} />

      <Section title="Options" aside="cheapest first">
        {eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground">None fit your business right now. The ones below say what would change that.</p>
        ) : (
          <OptionsTable options={eligible} need={data.need.amount_minor} currency={currency} selectedId={selectedId} onSelect={open} />
        )}
        <NotYet options={notYet} onSelect={open} />
      </Section>

      <Readiness data={data} onPack={() => setPanel({ kind: "pack" })} onProfile={() => setPanel({ kind: "profile" })} />

      <p className="max-w-3xl text-xs text-muted-foreground">{data.disclaimer}</p>

      <SidePanel open={selected !== null} onOpenChange={close} title={selected?.product ?? ""} description={selected?.provider}>
        {selected && <OptionPlanner key={selected.id} option={selected} need={data.need} safetyLevelMinor={data.safety_level_minor} currency={currency} />}
      </SidePanel>
      <LenderPackPanel pack={data.lender_pack} open={panel?.kind === "pack"} onOpenChange={close} />
      <ProfilePanel profile={data.profile} currency={currency} open={panel?.kind === "profile"} onOpenChange={close} />
    </>
  );
}

function GapHeadline({ data, currency, ask, onAsk, updating }: { data: Financing; currency: string; ask: FinancingAsk; onAsk: (a: FinancingAsk) => void; updating: boolean }) {
  const g = data.gap;
  const flow = useCashFlow();
  const custom = data.need.source === "you" && data.need.amount_minor;
  const money = (minor: number) => <Money minor={minor} currency={currency} />;

  const headline = custom ? (
    <Headline label="You're looking for" value={money(data.need.amount_minor!)} note={data.need.months ? `Over ${data.need.months} months` : "Options are costed for this amount"} />
  ) : !g ? (
    <Headline label="Cash gap to cover" value="None forecast" note={<StatusDot status="positive" label="Cash stays above your safety level for 90 days" showLabel />} />
  ) : (
    <Headline
      label="Cash gap to cover"
      value={money(g.safety_level_minor - g.lowest_minor)}
      note={
        <span className="inline-flex flex-wrap items-center gap-x-1">
          Below your {money(g.safety_level_minor)} safety level for {g.days} days
          <InfoPopover label="How we cost the options" title="How we cost the options">
            <p>
              We cost each option for {money(g.amount_minor)}, the gap plus 5% for what borrowing costs.
            </p>
          </InfoPopover>
        </span>
      }
    />
  );

  return (
    <section aria-label="What you need" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:items-end lg:gap-12">
      <div className="grid gap-4">
        {headline}
        <div className="flex flex-wrap items-center gap-2">
          <PlanCost data={data} ask={ask} onAsk={onAsk} updating={updating} />
          {custom && (
            <Button variant="ghost" size="sm" onClick={() => onAsk({})}>
              Use the forecast
            </Button>
          )}
        </div>
        <Disclosure summary="Summary">
          <div className="max-w-2xl">
            <Worded wording={data.summary} />
          </div>
        </Disclosure>
      </div>
      {g && <GapPicture gap={g} series={flow.data?.series} currency={currency} />}
    </section>
  );
}

/** Compare for an amount and purpose the owner chooses instead of the forecast's gap: a pill that opens a small form. */
function PlanCost({ data, ask, onAsk, updating }: { data: Financing; ask: FinancingAsk; onAsk: (a: FinancingAsk) => void; updating: boolean }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(ask.amount_minor ? String(ask.amount_minor / 100) : "");
  const [months, setMonths] = useState(ask.months ? String(ask.months) : "");
  const [purpose, setPurpose] = useState(ask.purpose ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = amount.trim() ? pounds(amount) : undefined;
    const m = months.trim() ? Number(months) : undefined;
    if (a === null) return setError("Enter an amount in pounds, such as 18000.");
    if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 120)) return setError("Choose between 1 and 120 months.");
    setError(null);
    onAsk({ ...(a ? { amount_minor: a } : {}), ...(m ? { months: m } : {}), ...(purpose ? { purpose } : {}) });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          {updating ? <Loader2Icon className="animate-spin" aria-hidden /> : <PlusIcon aria-hidden />} Plan a cost
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-4">
        <form onSubmit={submit} aria-label="Compare for a different amount" className="grid gap-3">
          <p className="text-sm font-medium">Compare for a planned cost</p>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="need-amount">Amount (£)</Label>
              <Input id="need-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 18000" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="need-months">Months</Label>
              <Input id="need-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} placeholder="Any" />
            </div>
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
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={updating}>
              Compare
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function Readiness({ data, onPack, onProfile }: { data: Financing; onPack: () => void; onProfile: () => void }) {
  const done = data.readiness.filter((r) => r.ok).length;
  const total = data.readiness.length;
  return (
    <Section
      title="What a lender looks at"
      aside={`${done} of ${total} ready`}
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onProfile}>
            <StoreIcon aria-hidden /> Business profile
          </Button>
          <Button variant="secondary" size="sm" onClick={onPack}>
            <FileTextIcon aria-hidden /> Lender pack
          </Button>
        </>
      }
    >
      <div className="flex max-w-xl items-center gap-3">
        <Meter value={done} max={total} label={`${done} of ${total} ready for a lender`} tone={done === total ? "positive" : "accent"} />
        <InfoPopover label="About this checklist">
          <p>This is not a credit score. Lenders decide on their own terms.</p>
        </InfoPopover>
      </div>
      <Disclosure summary="Checklist">
        <ul className="grid max-w-2xl divide-y border-y">
          {data.readiness.map((r) => (
            <li key={r.id} className="flex gap-3 py-2.5 text-sm">
              {r.ok ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Ready" />
              ) : (
                <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not yet" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap justify-between gap-x-4">
                  <span>{r.label}</span>
                  <span className="text-muted-foreground">{r.value}</span>
                </div>
                {!r.ok && r.tip && <p className="mt-0.5 text-xs text-muted-foreground">{r.tip}</p>}
              </div>
            </li>
          ))}
        </ul>
      </Disclosure>
    </Section>
  );
}
