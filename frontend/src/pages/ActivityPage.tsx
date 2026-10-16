import { useVirtualizer } from "@tanstack/react-virtual";
import { ActivityIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useActivity } from "@/api/hooks";
import type { ActivityEntry } from "@/api/types";
import { ApprovalBadge } from "@/components/ApprovalBadge";
import { PageHeader } from "@/components/PageHeader";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";

type ActorFilter = "all" | "people" | "ai" | "system";

function actorKind(actor: string): Exclude<ActorFilter, "all"> {
  if (actor.startsWith("user:")) return "people";
  if (actor.startsWith("ai") || actor.startsWith("agent")) return "ai";
  return "system";
}

export default function ActivityPage() {
  const activity = useActivity();
  return (
    <div className="grid gap-6">
      <QueryView
        query={activity}
        loading={
          <>
            <PageHeader title="Activity" description="Every step, in order. Nothing here can be edited or removed." />
            <ListSkeleton rows={8} />
          </>
        }
        empty={
          <>
            <PageHeader title="Activity" description="Every step, in order. Nothing here can be edited or removed." />
            <EmptyState icon={ActivityIcon} title="No activity yet" description="Every document received, AI step, match, approval and change will be recorded here." />
          </>
        }
      >
        {(data) => (
          <>
            <PageHeader
              title="Activity"
              description="Every step, in order. Nothing here can be edited or removed."
              actions={
                data.chain_ok ? (
                  <Badge variant="positive" title="Each entry includes a fingerprint of the one before it, and the chain checks out.">
                    <ShieldCheckIcon aria-hidden /> Log intact
                  </Badge>
                ) : (
                  <Badge variant="danger" title="An entry doesn't match the one before it. The business owner has been alerted.">
                    <ShieldAlertIcon aria-hidden /> Log check failed
                  </Badge>
                )
              }
            />
            <Timeline entries={data.entries} />
          </>
        )}
      </QueryView>
    </div>
  );
}

function Timeline({ entries }: { entries: ActivityEntry[] }) {
  const [actor, setActor] = useState<ActorFilter>("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return entries.filter(
      (e) => (actor === "all" || actorKind(e.actor) === actor) && (!term || `${e.summary} ${e.action}`.toLowerCase().includes(term)),
    );
  }, [entries, actor, q]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => parentRef.current, estimateSize: () => 64, overscan: 8 });

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
        <label htmlFor="activity-filter" className="sr-only">
          Filter activity
        </label>
        <Input id="activity-filter" placeholder="Filter by what happened" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 max-w-xs" />
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No activity matches these filters.</p>
      ) : (
        <div ref={parentRef} className="max-h-[70vh] overflow-y-auto rounded-xl border bg-card shadow-card">
          <ol aria-label="Activity log" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const e = shown[v.index]!;
              return (
                <li
                  key={e.id}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 flex items-start gap-3 border-b px-4 py-3"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{e.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      <time dateTime={e.at}>{formatDateTime(e.at)}</time> · {actorKind(e.actor) === "people" ? "Person" : actorKind(e.actor) === "ai" ? "AI" : "System"}
                    </p>
                  </div>
                  {e.level !== null && <ApprovalBadge level={e.level} className="max-sm:hidden" />}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </>
  );
}
