import { useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, HistoryIcon, PlusIcon, ShieldCheckIcon, SparklesIcon, Trash2Icon, TruckIcon, UsersIcon, WalletIcon, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/api/client";
import { useAsk, useAskStats, useAskThread, useAskThreads, useDeleteAskThread } from "@/api/hooks";
import type { AskMessage, AskReply, AskThread } from "@/api/types";
import { Answer, Question, Thinking } from "@/components/ask/Answer";
import { Composer } from "@/components/ask/Composer";
import { IconTile } from "@/components/kit";
import { PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { ErrorState } from "@/components/states";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Example questions by topic: a short label on the chip, the full question put in the box when clicked. */
const TOPICS: { id: string; label: string; icon: LucideIcon; questions: [label: string, question: string][] }[] = [
  {
    id: "cash",
    label: "Cash",
    icon: WalletIcon,
    questions: [
      ["Cash next month", "What does my cash look like next month?"],
      ["Why cash changed", "Why did my cash change this month?"],
      ["Afford an £18k van?", "Can I afford an £18,000 van?"],
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: UsersIcon,
    questions: [
      ["Who owes the most", "Who owes me the most?"],
      ["Invoices each month", "How many invoices did we send each month?"],
    ],
  },
  {
    id: "suppliers",
    label: "Suppliers",
    icon: TruckIcon,
    questions: [
      ["Price rises", "Have any suppliers raised their prices?"],
      ["Spend by category", "How much did we spend on each category this year?"],
    ],
  },
  {
    id: "documents",
    label: "Documents",
    icon: FileTextIcon,
    questions: [
      ["Late payment fees", "Which supplier mentions late payment fees?"],
      ["Cancelling", "What do our documents say about cancelling?"],
    ],
  },
];

function asMessages(question: string, reply: AskReply): AskMessage[] {
  const now = new Date().toISOString();
  return [
    { id: `q-${reply.id}`, role: "user", created_at: now, text: question },
    {
      id: reply.id,
      role: "assistant",
      created_at: now,
      answer: reply.answer,
      blocks: reply.blocks,
      sources: reply.sources,
      follow_ups: reply.follow_ups,
      suggestion: reply.suggestion,
      checked: reply.answer.ai_written,
    },
  ];
}

/** Puts a question in the box, ready to edit or send, with the cursor at the end. */
function focusBox() {
  requestAnimationFrame(() => {
    const box = document.getElementById("ask-input") as HTMLTextAreaElement | null;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
}

const turn = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } };

export default function AskPage() {
  const qc = useQueryClient();
  const ask = useAsk();
  const [threadId, setThreadId] = useState<string | null>(null);
  const thread = useAskThread(threadId);
  const [pending, setPending] = useState<{ question: string; error: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = threadId ? (thread.data?.messages ?? []) : [];

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages.length, pending]);

  const send = (question: string) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setPending({ question: q, error: null });
    setDraft("");
    ask.mutate(
      { question: q, thread_id: threadId },
      {
        onSuccess: (reply) => {
          // The new messages go straight into the conversation; the server's copy is the same
          qc.setQueryData<AskThread>(["ask", "thread", reply.thread_id], (old) => ({
            id: reply.thread_id,
            title: old?.title ?? q.slice(0, 80),
            messages: [...(old?.messages ?? []), ...asMessages(q, reply)],
          }));
          setThreadId(reply.thread_id);
          setPending(null);
          void qc.invalidateQueries({ queryKey: ["ask", "threads"] });
          void qc.invalidateQueries({ queryKey: ["ask", "stats"] });
        },
        onError: (err) => setPending({ question: q, error: errorMessage(err) }),
      },
    );
  };

  const pick = (question: string) => {
    setDraft(question);
    focusBox();
  };

  const openThread = (id: string | null) => {
    if (ask.isPending) return;
    setThreadId(id);
    setPending(null);
    setHistoryOpen(false);
  };

  const lastAnswerId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const empty = !threadId && messages.length === 0 && !pending;

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] w-full min-w-0 flex-col gap-6 md:min-h-[calc(100dvh-8.5rem)]">
      <PageHeader
        title="Ask"
        actions={
          <>
            {!empty && (
              <Button variant="secondary" onClick={() => openThread(null)} disabled={ask.isPending}>
                <PlusIcon aria-hidden /> <span className="max-sm:sr-only">New conversation</span>
              </Button>
            )}
            <Button variant="ghost" onClick={() => setHistoryOpen(true)} aria-haspopup="dialog">
              <HistoryIcon aria-hidden /> <span className="max-sm:sr-only">History</span>
            </Button>
          </>
        }
      />

      {empty ? (
        <EmptyAsk draft={draft} setDraft={setDraft} onSend={send} onPick={pick} pending={ask.isPending} />
      ) : (
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-2">
          <div className="min-w-0 flex-1">
            {threadId && thread.isPending ? (
              <ConversationSkeleton />
            ) : threadId && thread.isError ? (
              <ErrorState message={errorMessage(thread.error)} onRetry={() => void thread.refetch()} />
            ) : (
              <ol className="grid gap-8" aria-label="Conversation">
                <AnimatePresence initial={false}>
                  {messages.map((m) => (
                    <motion.li key={m.id} {...turn} className="grid min-w-0">
                      {m.role === "user" ? <Question text={m.text} /> : <Answer message={m} latest={m.id === lastAnswerId && !pending} onFollowUp={pick} />}
                    </motion.li>
                  ))}
                  {pending && (
                    <motion.li key="pending" {...turn} className="grid min-w-0 gap-8">
                      <Question text={pending.question} />
                      {pending.error ? <ErrorState message={pending.error} onRetry={() => send(pending.question)} /> : <Thinking />}
                    </motion.li>
                  )}
                </AnimatePresence>
              </ol>
            )}
            {/* Kept clear of the question box (and the phone menu) when scrolled to */}
            <div ref={endRef} className="scroll-mb-44 md:scroll-mb-28" />
          </div>
          {/* Stays at the bottom (above the phone menu), with the conversation fading out behind it */}
          <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] -mx-2 bg-gradient-to-t from-background from-70% to-transparent px-2 pb-3 pt-6 md:bottom-0 md:pb-5">
            <Composer value={draft} onChange={setDraft} onSend={() => send(draft)} pending={ask.isPending} />
          </div>
        </div>
      )}

      <SidePanel open={historyOpen} onOpenChange={setHistoryOpen} title="History">
        <ThreadList current={threadId} onOpen={openThread} onDeleted={(id) => id === threadId && openThread(null)} disabled={ask.isPending} />
      </SidePanel>
    </div>
  );
}

/** The first thing you see: one question box in the middle, a few examples under it. */
function EmptyAsk({
  draft,
  setDraft,
  onSend,
  onPick,
  pending,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: (q: string) => void;
  onPick: (q: string) => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-7 pb-[8vh]">
      <div className="grid justify-items-center gap-3 text-center">
        <IconTile icon={SparklesIcon} tone="accent" className="size-11 [&>svg]:size-5" />
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">What would you like to know?</h2>
      </div>
      <div className="w-full max-w-2xl">
        <Composer variant="hero" value={draft} onChange={setDraft} onSend={() => onSend(draft)} pending={pending} />
      </div>
      <Tabs defaultValue={TOPICS[0]!.id} className="grid w-full max-w-2xl justify-items-center">
        <TabsList aria-label="Example questions by topic" className="max-w-full">
          {TOPICS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.id} value={t.id} className="px-2.5 sm:px-3">
                <Icon className="hidden size-3.5 sm:block" aria-hidden />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {TOPICS.map((t) => (
          <TabsContent key={t.id} value={t.id}>
            <div role="group" aria-label={`${t.label} questions`} className="flex flex-wrap justify-center gap-2">
              {t.questions.map(([label, question]) => (
                <button
                  key={label}
                  type="button"
                  title={question}
                  onClick={() => onPick(question)}
                  className="rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium transition-colors hover:border-foreground/20 hover:bg-accent"
                >
                  {label}
                </button>
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <AskStatsLine />
    </div>
  );
}

/** How this person's questions were answered so far. Shown once there is something to count. */
function AskStatsLine() {
  const stats = useAskStats().data;
  if (!stats || stats.answered_from_data === 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <ShieldCheckIcon className="size-3.5 text-positive" aria-hidden />
      {stats.answered_from_data} of {stats.questions} answered from your records, {stats.checked_first_try} passed our fact check first time
    </p>
  );
}

function ConversationSkeleton() {
  return (
    <div className="grid gap-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <div className="grid gap-2.5 sm:pl-10">
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="mt-2 h-28 w-full rounded-xl" />
      </div>
    </div>
  );
}

function ThreadList({
  current,
  onOpen,
  onDeleted,
  disabled,
}: {
  current: string | null;
  onOpen: (id: string | null) => void;
  onDeleted: (id: string) => void;
  disabled: boolean;
}) {
  const threads = useAskThreads();
  const items = threads.data?.items ?? [];
  return (
    <nav aria-label="Earlier conversations" className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Button variant="secondary" className="justify-start" onClick={() => onOpen(null)} disabled={disabled}>
        <PlusIcon aria-hidden /> New conversation
      </Button>
      {threads.isPending ? (
        <div className="grid gap-3 px-2.5 py-1" aria-hidden>
          {[70, 55, 80].map((w) => (
            <Skeleton key={w} className="h-3.5" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No conversations yet. Only you can see them.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          {items.map((t) => (
            <ThreadRow key={t.id} id={t.id} title={t.title} at={t.created_at} current={t.id === current} onOpen={onOpen} onDeleted={onDeleted} disabled={disabled} />
          ))}
        </ul>
      )}
    </nav>
  );
}

/** One earlier conversation: open it, or delete it after a quick check. */
function ThreadRow({
  id,
  title,
  at,
  current,
  onOpen,
  onDeleted,
  disabled,
}: {
  id: string;
  title: string;
  at: string;
  current: boolean;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  disabled: boolean;
}) {
  const del = useDeleteAskThread();
  const [confirming, setConfirming] = useState(false);
  const remove = () =>
    del.mutate(id, {
      onSuccess: () => {
        setConfirming(false);
        onDeleted(id);
        toast.success("Conversation deleted");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  return (
    <li className={cn("group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent", (current || confirming) && "bg-accent")}>
      <button
        type="button"
        onClick={() => onOpen(id)}
        disabled={disabled}
        aria-current={current ? "true" : undefined}
        className="flex min-w-0 flex-1 items-baseline gap-3 rounded-lg py-2 pl-2.5 text-left disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(at)}</span>
      </button>
      <Popover open={confirming} onOpenChange={setConfirming}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-danger focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            aria-label={`Delete conversation: ${title}`}
            disabled={disabled}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-3">
          <p className="text-sm font-medium">Delete this conversation?</p>
          <p className="mt-1 text-xs text-muted-foreground">It can't be brought back.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="xs" variant="destructive" onClick={remove} disabled={del.isPending}>
              Delete
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </li>
  );
}
