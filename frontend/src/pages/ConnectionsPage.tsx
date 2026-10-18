import { BookOpenIcon, ChevronRightIcon, CopyIcon, CreditCardIcon, LandmarkIcon, Loader2Icon, LockIcon, MailIcon, PlugIcon, RefreshCwIcon, UnplugIcon, type LucideIcon } from "lucide-react";
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
import { ListSkeleton } from "@/components/skeletons";
import { IconTile, InfoPopover, KeyValues, Section, StatStrip } from "@/components/kit";
import { SidePanel } from "@/components/panels";
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
    <div className="grid grid-cols-1 gap-8">
      <PageHeader
        title="Connections"
        actions={
          <InfoPopover label="What we do with these" title="Read-only, with one exception">
            <p>We only ever read from these sources. The one thing we write is an update to your accounting software, and only after it's approved.</p>
          </InfoPopover>
        }
      />
      <QueryView
        query={connections}
        loading={<ListSkeleton rows={4} />}
        empty={<EmptyState icon={PlugIcon} title="No connections yet" description="Connect your bills inbox first. A payment platform, bank account and accounting software are optional." />}
      >
        {(data) => (
          <>
            <ul aria-label="Sources" className="divide-y rounded-xl border bg-card">
              {data.items.map((c) => (
                <ConnectionRow key={c.kind} connection={c} />
              ))}
            </ul>
            {data.accounts.length > 0 && <Accounts accounts={data.accounts} />}
          </>
        )}
      </QueryView>
    </div>
  );
}

function statusLine(c: Connection): string {
  if (c.last_sync_at) return `Synced ${formatRelative(c.last_sync_at)}`;
  return c.status !== "disconnected" ? "Not synced yet" : "Never connected";
}

/** One source: what it is, whether it's working, and the one thing to do next. The rest opens in a side panel. */
function ConnectionRow({ connection: c }: { connection: Connection }) {
  const can = useCan();
  const connect = useConnect();
  const sync = useSync();
  const disconnect = useDisconnect();
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const Icon = ICONS[c.kind];
  const status = STATUS[c.status] ?? STATUS.disconnected;
  const allowed = can("connect_tools");
  const busy = connect.isPending || sync.isPending || disconnect.isPending;
  const reasonId = `connect-reason-${c.kind}`;
  const isOn = c.status !== "disconnected";
  const counts = c.counts ? Object.entries(c.counts).filter(([, n]) => typeof n === "number" && n > 0) : [];
  const tone = c.status === "connected" ? "accent" : c.status === "error" ? "danger" : c.status === "expired" ? "warning" : "neutral";

  const done = (verb: string) => (res: SyncResult) => {
    const summary = countsSummary(res.counts);
    toast.success(`${c.title} ${verb}.${summary ? ` Found ${summary}.` : ""}`);
  };
  const failed = (err: unknown) => toast.error(errorMessage(err));

  const connectButton = (label: string) =>
    c.provider === "quickbooks" && allowed ? (
      // A plain link: the server sends the browser on to Intuit's sign-in page, and Intuit sends it back here
      <Button size="sm" asChild>
        <a href="/connect/quickbooks/start">{label}</a>
      </Button>
    ) : c.provider !== "mailpit" ? (
      <Button
        size="sm"
        disabled={!allowed || busy}
        aria-describedby={allowed ? undefined : reasonId}
        onClick={() => c.provider !== "quickbooks" && c.provider !== "mailpit" && connect.mutate(c.provider, { onSuccess: done("connected"), onError: failed })}
      >
        {connect.isPending && <Loader2Icon className="animate-spin" aria-hidden />} {label}
      </Button>
    ) : null;

  // Exactly one next step per source
  const action = !isOn
    ? connectButton("Connect")
    : c.status !== "connected" && !c.required
      ? connectButton("Reconnect")
      : (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => sync.mutate(c.provider, { onSuccess: done(c.provider === "mailpit" ? "checked for new emails" : "is up to date"), onError: failed })}
        >
          {sync.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <RefreshCwIcon aria-hidden />}
          {c.provider === "mailpit" ? "Check for new emails" : c.status === "error" ? "Try again" : "Sync now"}
        </Button>
      );

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 px-4 py-4 sm:grid-cols-[2.5rem_minmax(0,15rem)_minmax(0,1fr)_auto_auto] sm:px-5">
      <IconTile icon={Icon} tone={tone} className="size-10 [&_svg]:size-5" />
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{c.title}</h2>
        <p className="truncate text-xs text-muted-foreground">{c.provider_label}</p>
      </div>
      <div className="col-start-2 grid min-w-0 gap-1 sm:col-start-auto">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <StatusDot status={status.status} label={status.label} showLabel={c.status !== "connected"} className="text-sm" />
          <span className="text-sm text-muted-foreground">{statusLine(c)}</span>
        </span>
        {c.address && <InboxAddress address={c.address} />}
        {c.error && c.status !== "connected" && (
          <p role="alert" className="truncate text-xs text-danger" title={c.error}>
            {c.error}
          </p>
        )}
      </div>
      <div className="col-start-2 flex items-center gap-1 sm:col-start-auto sm:justify-end">
        {action}
        <Button variant="ghost" size="sm" className="text-muted-foreground sm:hidden" onClick={() => setDetails(true)}>
          Details
        </Button>
        {!allowed && !c.required && (
          <span title="Only a business owner or finance manager can connect or disconnect." className="text-muted-foreground">
            <LockIcon className="size-3.5" aria-hidden />
            <span id={reasonId} className="sr-only">
              Only a business owner or finance manager can connect or disconnect.
            </span>
          </span>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" className="max-sm:hidden" aria-label={`${c.title} details`} onClick={() => setDetails(true)}>
        <ChevronRightIcon aria-hidden />
      </Button>

      <SidePanel open={details} onOpenChange={setDetails} title={c.title} description={c.provider_label}>
        <div className="grid gap-6">
          <div className="flex items-center gap-3">
            <IconTile icon={Icon} tone={tone} className="size-10 [&_svg]:size-5" />
            <div className="grid gap-0.5">
              <StatusDot status={status.status} label={status.label} showLabel />
              <span className="text-xs text-muted-foreground">{statusLine(c)}</span>
            </div>
          </div>
          <KeyValues
            items={[
              { label: "What we read", value: c.what },
              { label: "Required", value: c.required ? "Yes" : "No, optional" },
            ]}
          />
          {counts.length > 0 && isOn && (
            <StatStrip items={counts.slice(0, 4).map(([k, n]) => ({ label: capitalise(k.replace(/_/g, " ")), value: n.toLocaleString("en-GB") }))} />
          )}
          {c.error && c.status !== "connected" && <p className="rounded-lg bg-danger-soft/50 px-3 py-2 text-sm text-danger">{c.error}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            {action}
            {isOn && !c.required && (
              <Button size="sm" variant="ghost" disabled={!allowed || busy} aria-describedby={allowed ? undefined : reasonId} onClick={() => setConfirming(true)}>
                <UnplugIcon aria-hidden /> Disconnect
              </Button>
            )}
          </div>
          {!allowed && !c.required && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockIcon className="size-3.5 shrink-0" aria-hidden /> Only a business owner or finance manager can connect or disconnect.
            </p>
          )}
        </div>
      </SidePanel>

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
                    setDetails(false);
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
    </li>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function InboxAddress({ address }: { address: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs">
      <span className="shrink-0 text-muted-foreground">Forward bills to</span>
      <span className="flex min-w-0 items-center">
        <span className="truncate font-medium">{address}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6"
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
    <Section className="grid-cols-1" title="Balances we read" aside={accounts.length > 1 ? accounts.length : undefined}>
      <ul aria-label="Balances we read" className="divide-y rounded-xl border bg-card">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <IconTile icon={a.source === "stripe" ? CreditCardIcon : LandmarkIcon} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {a.name}
                {a.mask && <span className="font-normal text-muted-foreground"> ••{a.mask}</span>}
              </p>
              <p className="text-xs text-muted-foreground">As of {formatRelative(a.as_of)}</p>
            </div>
            <Money minor={a.balance_minor} currency={a.currency || currency} className="text-sm font-semibold" />
          </li>
        ))}
      </ul>
    </Section>
  );
}
