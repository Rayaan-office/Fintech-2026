import { ChartLineIcon, FileDownIcon, FileTextIcon, ListChecksIcon, Loader2Icon, ReceiptIcon, StoreIcon, type LucideIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "@/api/client";
import { useShareLenderPack } from "@/api/hooks";
import type { Action, Financing } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { SidePanel } from "@/components/panels";
import { FormError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CONTENTS: { icon: LucideIcon; label: string }[] = [
  { icon: StoreIcon, label: "Business profile" },
  { icon: FileTextIcon, label: "12 months of profit and loss" },
  { icon: ReceiptIcon, label: "Unpaid invoices" },
  { icon: ChartLineIcon, label: "Cash forecast" },
  { icon: ListChecksIcon, label: "Lender checklist" },
];

/** The lender pack in one place: what's in it, the download, and sharing it (which an owner approves). */
export function LenderPackPanel({ pack, open, onOpenChange }: { pack: Financing["lender_pack"]; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} title="Lender pack" description="A PDF of your figures. We never apply for anything for you.">
      <div className="grid gap-6">
        <ul className="grid gap-2.5 text-sm">
          {CONTENTS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-2.5">
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              {label}
            </li>
          ))}
        </ul>
        <div>
          <Button asChild>
            <a href="/api/lender-pack.pdf" download>
              <FileDownIcon aria-hidden /> Download PDF
            </a>
          </Button>
        </div>
        {pack.can_share && (
          <section aria-labelledby="share-heading" className="grid gap-3 border-t pt-5">
            <div>
              <h3 id="share-heading" className="text-sm font-semibold">
                Share with a lender
              </h3>
              <p className="text-xs text-muted-foreground">{pack.approver}</p>
            </div>
            <ShareForm onDone={() => onOpenChange(false)} />
          </section>
        )}
      </div>
    </SidePanel>
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
        <p className="text-sm text-muted-foreground">Prepared. Exactly this PDF is emailed once a business owner approves.</p>
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
        <Button type="submit" variant="secondary" disabled={share.isPending || !lender.trim() || !email.trim()}>
          {share.isPending && <Loader2Icon className="animate-spin" aria-hidden />} Prepare and ask for approval
        </Button>
      </div>
    </form>
  );
}
