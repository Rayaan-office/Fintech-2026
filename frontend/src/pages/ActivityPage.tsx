import { ActivityIcon, CogIcon, DownloadIcon, Loader2Icon, SearchIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useActivity, useActivityCheck } from "@/api/hooks";
import type { ActivityEntry, ApprovalLevel } from "@/api/types";
import { ApprovalBadge } from "@/components/ApprovalBadge";
import { Initials } from "@/components/Initials";
import { FilterPills, InfoPopover, KeyValues } from "@/components/kit";
import { PageHeader } from "@/components/PageHeader";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, localDay } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  handoff_created: () => "A phone upload code was made (works for 10 minutes)",
  conversation_deleted: () => "An Ask conversation was deleted",
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

const KIND_ICON: Record<Exclude<ActorFilter, "all">, { icon: LucideIcon; className: string }> = {
  people: { icon: UserRoundIcon, className: "bg-positive-soft text-positive" },
  ai: { icon: SparklesIcon, className: "bg-primary-soft text-primary" },
  system: { icon: CogIcon, className: "bg-muted text-muted-foreground" },
};

const weekdayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const weekdayYearFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "Today", "Yesterday" or "Thursday 15 October" for the day an entry happened, where the person is. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = localDay(d);
  if (day === localDay(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day === localDay(y)) return "Yesterday";
  return (d.getFullYear() === now.getFullYear() ? weekdayFmt : weekdayYearFmt).format(d);
}

export default function ActivityPage() {
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Activity"
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
  const explain = (
    <InfoPopover label="How the log protects itself" title="A log that can't be quietly changed">
      <p>Every entry carries a fingerprint of the one before it, like links in a chain. Changing or removing any entry breaks every link after it.</p>
      <p>Each time you open this page we recompute the whole chain. Nothing here can be edited or removed.</p>
    </InfoPopover>
  );
  if (check.isPending) {
    return (
      <Badge variant="outline">
        <Loader2Icon className="animate-spin" aria-hidden /> Checking the log
      </Badge>
    );
  }
  if (check.isError || !check.data) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <Badge variant="outline">Log check unavailable</Badge>
        {explain}
      </span>
    );
  }
  const { intact, entries, broken_at } = check.data;
  return (
    <span className="inline-flex items-center gap-0.5">
      {intact ? (
        <Badge variant="positive" title={`All ${entries} entries check out.`}>
          <ShieldCheckIcon aria-hidden /> Log intact
        </Badge>
      ) : (
        <Badge variant="danger" title={`Entry ${broken_at} doesn't match the one before it, so the log may have been changed.`}>
          <ShieldAlertIcon aria-hidden /> Log check failed at entry {broken_at}
        </Badge>
      )}
      {explain}
    </span>
  );
}

function Timeline() {
  const me = useCurrentUser().user;
  const [actor, setActor] = useState<ActorFilter>("all");
  const [topic, setTopic] = useState<Topic>("all");
  const [q, setQ] = useState("");
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const activity = useActivity({ actor: ACTOR_PREFIX[actor] });

  const entries = useMemo(() => activity.data?.pages.flatMap((p) => p.items) ?? [], [activity.data]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const test = TOPICS.find((t) => t.id === topic)!.test;
    return entries.filter(
      (e) => (actor !== "system" || actorKind(e.actor) === "system") && test(e.event) && (!term || describeEntry(e).toLowerCase().includes(term)),
    );
  }, [entries, actor, topic, q]);

  if (activity.isPending) return <ListSkeleton rows={8} />;
  if (activity.isError) return <ErrorState message={errorMessage(activity.error)} onRetry={() => void activity.refetch()} />;
  if (entries.length === 0 && actor === "all") {
    return <EmptyState icon={ActivityIcon} title="No activity yet" description="Every document received, AI step, match, approval and change will be recorded here." />;
  }

  // Repeats in a row (the same step by the same actor on the same day) fold into one line
  const runs: ActivityEntry[][] = [];
  for (const e of shown) {
    const prev = runs[runs.length - 1]?.[0];
    if (prev && prev.event === e.event && prev.actor === e.actor && describeEntry(prev) === describeEntry(e) && levelOf(prev) === levelOf(e) && dayLabel(prev.at) === dayLabel(e.at)) runs[runs.length - 1]!.push(e);
    else runs.push([e]);
  }
  let lastDay = "";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <FilterPills
          label="Who acted"
          value={actor}
          onChange={setActor}
          options={[
            { value: "all", label: "All" },
            { value: "people", label: "People" },
            { value: "ai", label: "AI" },
            { value: "system", label: "System" },
          ]}
        />
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        <label htmlFor="activity-topic" className="sr-only">
          Show
        </label>
        <select
          id="activity-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value as Topic)}
          className="h-8 rounded-full border bg-card px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
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
        <span className="relative w-full sm:ml-auto sm:w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="activity-filter" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 rounded-full pl-8 text-[13px]" />
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No activity matches these filters.</p>
      ) : (
        <ol aria-label="Activity log" className="grid">
          {runs.map((run, i) => {
            const e = run[0]!;
            const day = dayLabel(e.at);
            const firstOfDay = day !== lastDay;
            const next = runs[i + 1]?.[0];
            const lastOfDay = !next || dayLabel(next.at) !== day;
            lastDay = day;
            return (
              <li key={e.seq} className="grid">
                {firstOfDay && <h2 className="pt-5 pb-2 text-[13px] font-medium text-muted-foreground first:pt-0">{day}</h2>}
                <Entry run={run} me={me} rail={[!firstOfDay, !lastOfDay]} open={openSeq === e.seq} onToggle={() => setOpenSeq((s) => (s === e.seq ? null : e.seq))} />
              </li>
            );
          })}
        </ol>
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

/** One step on the timeline: icon by who acted, the sentence and the time. The fingerprint and details open on click. */
function Entry({ run, me, rail, open, onToggle }: { run: ActivityEntry[]; me: { id: string; name: string }; rail: [boolean, boolean]; open: boolean; onToggle: () => void }) {
  const e = run[0]!;
  const reduce = useReducedMotion();
  const panelId = useId();
  const kind = actorKind(e.actor);
  const { icon: Icon, className } = KIND_ICON[kind];
  const who = actorName(e.actor, me.id);
  const level = levelOf(e);
  const extra = Object.entries(e.details ?? {}).filter(([k, v]) => k !== "type" && k !== "level" && v !== null && v !== "" && typeof v !== "object");
  return (
    <div className="relative">
      {/* The rail joining one step to the next on the same day */}
      {rail[0] && <span className="absolute top-0 left-[15px] h-6 w-px bg-border" aria-hidden />}
      {rail[1] && <span className="absolute top-6 bottom-0 left-[15px] w-px bg-border" aria-hidden />}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn("relative flex w-full items-center gap-3 rounded-lg py-2 pr-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring", open && "bg-accent/50")}
      >
        <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-background", className)} aria-hidden>
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 text-sm">{describeEntry(e)}</span>
          {run.length > 1 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular">
              ×{run.length}
              <span className="sr-only"> times</span>
            </span>
          )}
        </span>
        {level !== null && <ApprovalBadge level={level} className="max-sm:hidden" />}
        <span className="flex shrink-0 items-center gap-2">
          {kind === "people" && <Initials name={who === "You" ? me.name : "Team member"} size="sm" />}
          <span className="sr-only">{who}</span>
          <time dateTime={e.at} className="w-11 text-right text-xs text-muted-foreground tabular">
            {timeFmt.format(new Date(e.at))}
          </time>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            {run.length > 1 ? (
              <div className="mb-3 ml-11 overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-xs">
                <thead className="sr-only">
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Fingerprint</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {run.map((r) => (
                    <tr key={r.seq}>
                      <td className="w-44 py-1.5 pl-4 text-muted-foreground">{formatDateTime(r.at)}</td>
                      <td className="w-16 py-1.5 tabular">#{r.seq}</td>
                      <td className="py-1.5 pr-4 font-mono break-all">{r.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <KeyValues
                className="mb-3 ml-11 rounded-lg border bg-card px-4 py-3"
                items={[
                  { label: "Who", value: who },
                  { label: "When", value: formatDateTime(e.at) },
                  { label: "Entry", value: `#${e.seq}` },
                  { label: "Fingerprint", value: <span className="font-mono text-xs break-all">{e.hash}</span> },
                  ...(e.subject ? [{ label: "About", value: <span className="break-all">{e.subject}</span> }] : []),
                  ...extra.map(([k, v]) => ({ label: capitalise(k.replace(/_/g, " ")), value: <span className="break-words">{String(v)}</span> })),
                ]}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
