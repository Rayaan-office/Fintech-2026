import { useVirtualizer } from "@tanstack/react-virtual";
import { ActivityIcon, DownloadIcon, Loader2Icon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useActivity, useActivityCheck } from "@/api/hooks";
import type { ActivityEntry, ApprovalLevel } from "@/api/types";
import { ApprovalBadge } from "@/components/ApprovalBadge";
import { PageHeader } from "@/components/PageHeader";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";

type ActorFilter = "all" | "people" | "ai" | "system";
// People and AI filter on the server (the actor starts with this); "system" covers everything else
const ACTOR_PREFIX: Partial<Record<ActorFilter, string>> = { people: "user:", ai: "ai:" };

type Topic = "all" | "documents" | "approvals" | "connections" | "security";
const TOPICS: { id: Topic; label: string; test: (event: string) => boolean }[] = [
  { id: "all", label: "Everything", test: () => true },
  { id: "documents", label: "Documents and email", test: (e) => /^(document|email|details|ai_form|fields|original|gateway)/.test(e) },
  { id: "approvals", label: "Approvals", test: (e) => /^(action|approval)/.test(e) },
  { id: "connections", label: "Connections", test: (e) => /^(connection|notification)/.test(e) },
  { id: "security", label: "Sign-ins and security", test: (e) => /^(signed|two_step|sign_in|archive|ai_pause|ai_resume|activity|business)/.test(e) },
];

export function actorKind(actor: string): Exclude<ActorFilter, "all"> {
  if (actor.startsWith("user:")) return "people";
  if (actor.startsWith("ai")) return "ai";
  return "system";
}

const ACTION_LABELS: Record<string, string> = {
  accept_match: "accept a match",
  record_bill: "record a bill",
  approve_document: "record a checked document",
  post_to_accounting: "update the accounting software",
  send_payment_reminder: "email a customer",
  email_supplier: "email a supplier",
  schedule_payment: "schedule a payment",
  share_lender_pack: "share a lender pack",
  change_supplier_bank: "change supplier bank details",
  large_payment: "a large or first-time payment",
  record_bank_charge: "record a bank charge",
};

const PROVIDERS: Record<string, string> = { mailpit: "Email inbox", stripe: "Payment platform", plaid: "Bank account", quickbooks: "Accounting software" };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const what = (e: ActivityEntry) => ACTION_LABELS[str(e.details?.type)] ?? "a change";
const provider = (e: ActivityEntry) => PROVIDERS[e.subject ?? ""] ?? "A connection";
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EVENTS: Record<string, (e: ActivityEntry) => string> = {
  business_created: () => "Business set up",
  signed_in: () => "Signed in",
  two_step_passed: () => "Passed two-step sign-in",
  sign_in_locked: () => "An account was locked for 15 minutes after several failed sign-ins",
  document_received: (e) => `Document received${str(e.details?.source) === "email" ? " by email" : str(e.details?.source) === "photo" ? " as a photo" : ""}`,
  document_refused: (e) => `A file was refused${str(e.details?.reason) ? `: ${str(e.details?.reason)}` : ""}`,
  document_needs_person: () => "A document was sent to a person to check",
  document_failed: () => "A document couldn't be read automatically and was sent to a person",
  document_reprocessed: () => "A document was sent to be read again",
  details_hidden: () => "Personal details were hidden before the AI read anything",
  ai_form_filled: () => "The AI filled in the form from the hidden-details text",
  gateway_block: () => "The AI gateway blocked a request",
  fields_corrected: (e) => {
    const fields = Array.isArray(e.details?.fields) ? (e.details.fields as unknown[]).map((f) => String(f).replace(/_/g, " ")) : [];
    return fields.length ? `Corrected ${fields.join(", ")}` : "Checked what was read";
  },
  original_viewed: () => "Opened an original document",
  archive_tampered: () => "A stored original no longer matches its fingerprint",
  email_received: () => "Email received in the bills inbox",
  email_refused: () => "An email was refused",
  email_duplicate_ignored: () => "A repeated email was ignored",
  notification_received: (e) => `Update received from ${PROVIDERS[e.subject ?? ""]?.toLowerCase() ?? "a connected service"}`,
  connection_added: (e) => `${provider(e)} connected`,
  connection_synced: (e) => `${provider(e)} brought up to date`,
  connection_removed: (e) => `${provider(e)} disconnected`,
  action_proposed: (e) => `Suggested: ${what(e)}`,
  action_executed: (e) => `Done: ${what(e)}`,
  action_failed: (e) => `Couldn't finish: ${what(e)}`,
  action_cancelled: () => "A request was cancelled",
  action_undone: () => "A change was undone",
  approval_approve: (e) => `Approved: ${what(e)}`,
  approval_reject: (e) => `Rejected: ${what(e)}`,
  approval_refused: (e) => `An approval was refused${str(e.details?.reason) ? `: ${str(e.details?.reason)}` : ""}`,
  ai_paused: () => "AI actions were paused",
  ai_resumed: () => "AI actions were switched back on",
  activity_exported: () => "The activity log was downloaded",
};

/** Plain words for one log entry. */
export function describeEntry(e: ActivityEntry): string {
  return EVENTS[e.event]?.(e) ?? capitalise(e.event.replace(/_/g, " "));
}

function actorName(actor: string, myId: string): string {
  if (actor === `user:${myId}`) return "You";
  if (actor.startsWith("user:")) return "A team member";
  if (actor === "ai:auto") return "AI, automatically";
  if (actor.startsWith("ai")) return "AI";
  if (actor === "scheduler") return "Regular check";
  if (actor === "webhooks") return "Connected service";
  return "System";
}

function levelOf(e: ActivityEntry): ApprovalLevel | null {
  const l = e.details?.level;
  return typeof l === "number" && l >= 0 && l <= 4 ? (l as ApprovalLevel) : null;
}

export default function ActivityPage() {
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Activity"
        description="Every step, in order. Nothing here can be edited or removed."
        actions={
          <>
            <LogCheck />
            <Button variant="secondary" asChild>
              <a href="/api/activity/export.csv" download="activity.csv">
                <DownloadIcon aria-hidden /> Download CSV
              </a>
            </Button>
          </>
        }
      />
      <Timeline />
    </div>
  );
}

/** Recomputes every fingerprint on the server; any edit or removal breaks the chain. */
function LogCheck() {
  const check = useActivityCheck();
  if (check.isPending) {
    return (
      <Badge variant="outline">
        <Loader2Icon className="animate-spin" aria-hidden /> Checking the log
      </Badge>
    );
  }
  if (check.isError || !check.data) {
    return <Badge variant="outline">Log check unavailable</Badge>;
  }
  const { intact, entries, broken_at } = check.data;
  return intact ? (
    <Badge variant="positive" title={`Each entry includes a fingerprint of the one before it. All ${entries} entries check out.`}>
      <ShieldCheckIcon aria-hidden /> Log intact
    </Badge>
  ) : (
    <Badge variant="danger" title={`Entry ${broken_at} doesn't match the one before it, so the log may have been changed.`}>
      <ShieldAlertIcon aria-hidden /> Log check failed at entry {broken_at}
    </Badge>
  );
}

function Timeline() {
  const myId = useCurrentUser().user.id;
  const [actor, setActor] = useState<ActorFilter>("all");
  const [topic, setTopic] = useState<Topic>("all");
  const [q, setQ] = useState("");
  const activity = useActivity({ actor: ACTOR_PREFIX[actor] });

  const entries = useMemo(() => activity.data?.pages.flatMap((p) => p.items) ?? [], [activity.data]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const test = TOPICS.find((t) => t.id === topic)!.test;
    return entries.filter(
      (e) => (actor !== "system" || actorKind(e.actor) === "system") && test(e.event) && (!term || describeEntry(e).toLowerCase().includes(term)),
    );
  }, [entries, actor, topic, q]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  if (activity.isPending) return <ListSkeleton rows={8} />;
  if (activity.isError) return <ErrorState message={errorMessage(activity.error)} onRetry={() => void activity.refetch()} />;
  if (entries.length === 0 && actor === "all") {
    return <EmptyState icon={ActivityIcon} title="No activity yet" description="Every document received, AI step, match, approval and change will be recorded here." />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={actor} onValueChange={(v) => setActor(v as ActorFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="system">System</TabsTrigger>
          </TabsList>
        </Tabs>
        <label htmlFor="activity-topic" className="sr-only">
          Show
        </label>
        <select
          id="activity-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value as Topic)}
          className="h-9 rounded-lg border bg-card px-2 text-sm"
        >
          {TOPICS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <label htmlFor="activity-filter" className="sr-only">
          Filter activity
        </label>
        <Input id="activity-filter" placeholder="Filter by what happened" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 sm:max-w-xs" />
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No activity matches these filters.</p>
      ) : (
        <div ref={parentRef} className="max-h-[70vh] overflow-y-auto rounded-xl border bg-card shadow-card">
          <ol aria-label="Activity log" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const e = shown[v.index]!;
              const level = levelOf(e);
              const kind = actorKind(e.actor);
              return (
                <li
                  key={e.seq}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 flex items-start gap-3 border-b px-4 py-3"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <span className={kind === "ai" ? "mt-1.5 size-2 shrink-0 rounded-full bg-primary" : kind === "people" ? "mt-1.5 size-2 shrink-0 rounded-full bg-positive" : "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40"} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{describeEntry(e)}</p>
                    <p className="text-xs text-muted-foreground">
                      <time dateTime={e.at}>{formatDateTime(e.at)}</time> · {actorName(e.actor, myId)}
                      <span className="max-sm:hidden" title="This entry's fingerprint">
                        {" "}
                        · #{e.seq} <span className="font-mono">{e.hash}</span>
                      </span>
                    </p>
                  </div>
                  {level !== null && <ApprovalBadge level={level} className="max-sm:hidden" />}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {activity.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
            {activity.isFetchingNextPage && <Loader2Icon className="animate-spin" aria-hidden />}
            Show older activity
          </Button>
        </div>
      )}
    </>
  );
}
