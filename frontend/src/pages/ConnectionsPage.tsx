import { BookOpenIcon, CopyIcon, CreditCardIcon, InfoIcon, LandmarkIcon, Loader2Icon, MailIcon, PlugIcon, RefreshCwIcon, UnplugIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useConnect, useConnections, useDisconnect, useSync } from "@/api/hooks";
import type { ConnectedAccount, Connection, ConnectionKind, SyncResult } from "@/api/types";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot, type Status } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatRelative } from "@/lib/format";

const ICONS: Record<ConnectionKind, LucideIcon> = { email: MailIcon, payments: CreditCardIcon, bank: LandmarkIcon, accounting: BookOpenIcon };

const STATUS: Record<Connection["status"], { label: string; status: Status }> = {
  connected: { label: "Connected", status: "positive" },
  disconnected: { label: "Not connected", status: "neutral" },
  expired: { label: "Needs reconnecting", status: "warning" },
  error: { label: "Last sync failed", status: "danger" },
};

// Where Intuit's sign-in sends people back to: /connections?qbo=<outcome>
const QBO_OUTCOMES: Record<string, { kind: "success" | "warning" | "error" | "message"; text: string }> = {
  connected: { kind: "success", text: "QuickBooks is connected, and we've read your books." },
  connected_sync_failed: { kind: "warning", text: "QuickBooks is connected, but the first read didn't finish. Try Sync in a minute." },
  cancelled: { kind: "message", text: "QuickBooks sign-in was cancelled. Nothing was changed." },
  failed: { kind: "error", text: "We couldn't connect QuickBooks. Please try again." },
  taken: { kind: "error", text: "That QuickBooks company is already connected to another business." },
};

function useQboOutcome() {
  const [params, setParams] = useSearchParams();
  const outcome = params.get("qbo");
  useEffect(() => {
    if (!outcome) return;
    const o = QBO_OUTCOMES[outcome];
    // On a fresh page load this runs before the toaster is listening, so wait a tick.
    // A fixed id, so a repeated effect doesn't show it twice.
    if (o) setTimeout(() => toast[o.kind](o.text, { id: "qbo-outcome" }), 0);
    setParams(
      (p) => {
        p.delete("qbo");
        return p;
      },
      { replace: true },
    );
  }, [outcome, setParams]);
}

/** "266 transactions, 2 accounts" from the counts the last sync returned. */
export function countsSummary(counts: Record<string, number> | null | undefined): string | null {
  if (!counts) return null;
  const parts = Object.entries(counts)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .slice(0, 4)
    .map(([k, n]) => `${n.toLocaleString("en-GB")} ${k.replace(/_/g, " ")}`);
  return parts.length ? parts.join(", ") : null;
}

export default function ConnectionsPage() {
  const connections = useConnections();
  useQboOutcome();
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader title="Connections" description="Where your money information comes from. We only ever read from these, and write to accounting software only after approval." />
      <QueryView
        query={connections}
        loading={<CardsSkeleton count={4} />}
        empty={<EmptyState icon={PlugIcon} title="No connections yet" description="Connect your bills inbox first. A payment platform, bank account and accounting software are optional." />}
      >
        {(data) => (
          <>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {data.items.map((c) => (
                <li key={c.kind}>
                  <ConnectionCard connection={c} />
                </li>
              ))}
            </ul>
            {data.accounts.length > 0 && <Accounts accounts={data.accounts} />}
          </>
        )}
      </QueryView>
    </div>
  );
}

function ConnectionCard({ connection: c }: { connection: Connection }) {
  const can = useCan();
  const connect = useConnect();
  const sync = useSync();
  const disconnect = useDisconnect();
  const [confirming, setConfirming] = useState(false);
  const Icon = ICONS[c.kind];
  const status = STATUS[c.status] ?? STATUS.disconnected;
  const allowed = can("connect_tools");
  const busy = connect.isPending || sync.isPending || disconnect.isPending;
  const reasonId = `connect-reason-${c.kind}`;
  const isOn = c.status !== "disconnected";
  const counts = countsSummary(c.counts);

  const done = (verb: string) => (res: SyncResult) => {
    const summary = countsSummary(res.counts);
    toast.success(`${c.title} ${verb}.${summary ? ` Found ${summary}.` : ""}`);
  };
  const failed = (err: unknown) => toast.error(errorMessage(err));

  const connectButton = (label: string) =>
    c.provider === "quickbooks" && allowed ? (
      // A plain link: the server sends the browser on to Intuit's sign-in page, and Intuit sends it back here
      <Button size="sm" variant={isOn ? "secondary" : "default"} asChild>
        <a href="/connect/quickbooks/start">
          <PlugIcon aria-hidden /> {label}
        </a>
      </Button>
    ) : c.provider !== "mailpit" ? (
      <Button
        size="sm"
        variant={isOn ? "secondary" : "default"}
        disabled={!allowed || busy}
        aria-describedby={allowed ? undefined : reasonId}
        onClick={() => c.provider !== "quickbooks" && c.provider !== "mailpit" && connect.mutate(c.provider, { onSuccess: done("connected"), onError: failed })}
      >
        {connect.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <PlugIcon aria-hidden />} {label}
      </Button>
    ) : null;

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card shadow-card">
      <div className="flex flex-1 gap-4 p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 content-start gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <h2 className="font-semibold">{c.title}</h2>
            <span className="text-xs text-muted-foreground">{c.provider_label}</span>
          </div>
          <p className="text-sm text-muted-foreground">{c.what}</p>
          <StatusDot status={status.status} label={status.label} showLabel />
          <p className="text-xs text-muted-foreground">
            {c.last_sync_at ? `Last synced ${formatRelative(c.last_sync_at)}` : isOn ? "Not synced yet" : "Never connected"}
            {counts && isOn && ` · ${counts}`}
          </p>
          {c.address && <InboxAddress address={c.address} />}
          {c.error && c.status !== "connected" && (
            <p role="alert" className="mt-1 rounded-md bg-danger-soft/60 px-2.5 py-1.5 text-sm text-danger">
              {c.error}
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-2 border-t px-5 py-3">
        <div className="flex flex-wrap gap-2">
          {!isOn && connectButton("Connect")}
          {isOn && (
            <Button
              size="sm"
              variant={c.status === "connected" ? "secondary" : "default"}
              disabled={busy}
              onClick={() => sync.mutate(c.provider, { onSuccess: done(c.provider === "mailpit" ? "checked for new emails" : "is up to date"), onError: failed })}
            >
              {sync.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <RefreshCwIcon aria-hidden />}
              {c.provider === "mailpit" ? "Check for new emails" : c.status === "error" ? "Try again" : "Sync now"}
            </Button>
          )}
          {isOn && c.status !== "connected" && !c.required && connectButton("Reconnect")}
          {isOn && !c.required && (
            <Button size="sm" variant="ghost" disabled={!allowed || busy} aria-describedby={allowed ? undefined : reasonId} onClick={() => setConfirming(true)}>
              <UnplugIcon aria-hidden /> Disconnect
            </Button>
          )}
        </div>
        {!allowed && !c.required && (
          <p id={reasonId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="size-3.5 shrink-0" aria-hidden /> Only a business owner or finance manager can connect or disconnect.
          </p>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {c.title.toLowerCase()}?</DialogTitle>
            <DialogDescription>
              We'll stop reading from {c.provider_label}. What we've already read stays in your records, and you can connect again at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep connected
            </Button>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(c.provider, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast(`${c.title} disconnected.`);
                  },
                  onError: failed,
                })
              }
            >
              {disconnect.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InboxAddress({ address }: { address: string }) {
  return (
    <div className="mt-1 grid min-w-0 gap-0.5 text-sm">
      <span className="text-xs text-muted-foreground">Forward bills to</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium">{address}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label="Copy the bills inbox address"
          onClick={() =>
            void navigator.clipboard?.writeText(address).then(
              () => toast.success("Address copied."),
              () => toast.error("We couldn't copy it. Select the address and copy it instead."),
            )
          }
        >
          <CopyIcon className="size-3.5" aria-hidden />
        </Button>
      </span>
    </div>
  );
}

function Accounts({ accounts }: { accounts: ConnectedAccount[] }) {
  const currency = useCurrentUser().business.currency;
  return (
    <section aria-labelledby="accounts-heading" className="grid gap-3">
      <h2 id="accounts-heading" className="text-sm font-medium">
        Balances we read
      </h2>
      <ul className="divide-y rounded-xl border bg-card shadow-card">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {a.name}
                {a.mask && <span className="text-muted-foreground"> ending {a.mask}</span>}
              </p>
              <p className="text-xs text-muted-foreground">As of {formatRelative(a.as_of)}</p>
            </div>
            <Money minor={a.balance_minor} currency={a.currency || currency} className="text-sm font-medium" />
          </li>
        ))}
      </ul>
    </section>
  );
}
