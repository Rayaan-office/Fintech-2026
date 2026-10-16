import { BookOpenIcon, CreditCardIcon, InfoIcon, LandmarkIcon, MailIcon, PlugIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useConnections, useReconnect } from "@/api/hooks";
import type { Connection, ConnectionKind } from "@/api/types";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { CardsSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot, type Status } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";

const KINDS: Record<ConnectionKind, { label: string; icon: LucideIcon }> = {
  email: { label: "Bills inbox", icon: MailIcon },
  payments: { label: "Payment platform", icon: CreditCardIcon },
  bank: { label: "Bank account", icon: LandmarkIcon },
  accounting: { label: "Accounting software", icon: BookOpenIcon },
};

const STATUS: Record<Connection["status"], { label: string; status: Status }> = {
  ok: { label: "Connected", status: "positive" },
  attention: { label: "Needs attention", status: "warning" },
  error: { label: "Not working", status: "danger" },
  not_connected: { label: "Not connected", status: "neutral" },
};

export default function ConnectionsPage() {
  const connections = useConnections();
  return (
    <div className="grid gap-6">
      <PageHeader title="Connections" description="Where your money information comes from. We only ever take read access, and write to accounting software only after approval." />
      <QueryView
        query={connections}
        loading={<CardsSkeleton count={4} />}
        empty={<EmptyState icon={PlugIcon} title="No connections yet" description="Connect your bills inbox first. A payment platform, bank account and accounting software are optional." />}
      >
        {(data) => (
          <ul className="grid gap-4 sm:grid-cols-2">
            {data.items.map((c) => (
              <li key={c.id}>
                <ConnectionCard connection={c} />
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </div>
  );
}

function safeRedirect(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "https:" || u.origin === window.location.origin ? u.href : null;
  } catch {
    return null;
  }
}

function ConnectionCard({ connection: c }: { connection: Connection }) {
  const can = useCan();
  const reconnect = useReconnect();
  const kind = KINDS[c.kind];
  const Icon = kind.icon;
  const status = STATUS[c.status];
  const allowed = can("connect_tools");
  const reasonId = `reconnect-reason-${c.id}`;

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card shadow-card">
      <div className="flex flex-1 gap-4 p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <div className="grid min-w-0 gap-1">
          <div className="text-xs text-muted-foreground">{kind.label}</div>
          <h2 className="truncate font-semibold">{c.name}</h2>
          <StatusDot status={status.status} label={status.label} showLabel />
          <p className="text-xs text-muted-foreground">{c.last_synced_at ? `Synced ${formatRelative(c.last_synced_at)}` : "Never synced"}</p>
          {c.message && <p className="text-sm">{c.message}</p>}
        </div>
      </div>
      <div className="grid gap-2 border-t px-5 py-3">
        <div>
          <Button
            variant={c.status === "ok" ? "ghost" : "secondary"}
            size="sm"
            disabled={!allowed || reconnect.isPending}
            aria-describedby={allowed ? undefined : reasonId}
            onClick={() =>
              reconnect.mutate(c.id, {
                onSuccess: (res) => {
                  const target = res.redirect_url ? safeRedirect(res.redirect_url) : null;
                  if (target) window.location.assign(target);
                  else toast.success(`${c.name} reconnected.`);
                },
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            <RefreshCwIcon aria-hidden /> {c.status === "not_connected" ? "Connect" : "Reconnect"}
          </Button>
        </div>
        {!allowed && (
          <p id={reasonId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="size-3.5" aria-hidden /> Only a business owner or finance manager can change connections.
          </p>
        )}
      </div>
    </div>
  );
}
