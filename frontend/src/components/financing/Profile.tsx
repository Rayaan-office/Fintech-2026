import { Loader2Icon, PencilIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useSaveProfile } from "@/api/hooks";
import type { BusinessProfile, OwnerField, ProfileField } from "@/api/types";
import { Money } from "@/components/Money";
import { SidePanel } from "@/components/panels";
import { FormError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";

export const selectClass = "h-10 w-full rounded-lg border border-input bg-card px-3 text-base shadow-card sm:text-sm";

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

/** The business profile in a side panel: what we worked out, corrections beside it, and the form to change it. */
export function ProfilePanel({ profile, currency, open, onOpenChange }: { profile: BusinessProfile; currency: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const can = useCan();
  const me = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const owner = profile.owner_fields;
  const change = (o: boolean) => {
    if (!o) setEditing(false);
    onOpenChange(o);
  };
  return (
    <SidePanel
      open={open}
      onOpenChange={change}
      title={editing ? "Edit business profile" : "Business profile"}
      description={editing ? "Corrections replace the automatic value until you put it back." : "Worked out from your records."}
    >
      {editing ? (
        <ProfileForm profile={profile} onDone={() => setEditing(false)} />
      ) : (
        <div className="grid gap-4">
          {can("edit_profile") ? (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <PencilIcon aria-hidden /> Edit profile
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only a business owner can change the profile.</p>
          )}
          <dl className="grid">
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
        </div>
      )}
    </SidePanel>
  );
}

function ProfileRow({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b py-2.5 text-sm last:border-0">
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
