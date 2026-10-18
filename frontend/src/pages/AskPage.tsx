import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon, HistoryIcon, Loader2Icon, MailIcon, MicIcon, PlusIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useAsk, useAskAct, useAskThread, useAskThreads } from "@/api/hooks";
import type { Action, AskBlock, AskMessage, AskReply, AskThread } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { Worded } from "@/components/AiText";
import { ChartCard } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { ListSkeleton } from "@/components/skeletons";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { formatDate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const STARTERS = [
  "Who owes me the most?",
  "What does my cash look like next month?",
  "Have any suppliers raised their prices?",
  "Why did my cash change this month?",
  "Can I afford an £18,000 van?",
];

type AssistantMessage = Extract<AskMessage, { role: "assistant" }>;

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
        },
        onError: (err) => setPending({ question: q, error: errorMessage(err) }),
      },
    );
  };

  const openThread = (id: string | null) => {
    if (ask.isPending) return;
    setThreadId(id);
    setPending(null);
    setHistoryOpen(false);
  };

  const lastAnswerId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside aria-label="Conversations" className="hidden lg:block">
        <div className="sticky top-4">
          <ThreadList current={threadId} onOpen={openThread} disabled={ask.isPending} />
        </div>
      </aside>

      <div className="mx-auto flex min-h-[calc(100dvh-10rem)] w-full min-w-0 max-w-3xl flex-col gap-6">
        <PageHeader
          title="Ask"
          description="Questions about your business, answered from your own records."
          actions={
            <>
              {threadId && (
                <Button variant="secondary" onClick={() => openThread(null)} disabled={ask.isPending}>
                  <PlusIcon aria-hidden /> New conversation
                </Button>
              )}
              <Button variant="ghost" className="lg:hidden" onClick={() => setHistoryOpen(true)}>
                <HistoryIcon aria-hidden /> Earlier
              </Button>
            </>
          }
        />

        <div className="min-w-0 flex-1">
          {threadId && thread.isPending ? (
            <ListSkeleton rows={3} />
          ) : threadId && thread.isError ? (
            <ErrorState message={errorMessage(thread.error)} onRetry={() => void thread.refetch()} />
          ) : messages.length === 0 && !pending ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">Try one of these:</p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-full border bg-card px-3 py-1.5 text-left text-sm shadow-card hover:bg-accent">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="grid gap-6" aria-label="Conversation">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.li key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="grid min-w-0 gap-3">
                    {m.role === "user" ? <Question text={m.text} /> : <Answer message={m} latest={m.id === lastAnswerId && !pending} onFollowUp={send} />}
                  </motion.li>
                ))}
                {pending && (
                  <motion.li key="pending" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="grid min-w-0 gap-3">
                    <Question text={pending.question} />
                    {pending.error ? (
                      <ErrorState message={pending.error} onRetry={() => send(pending.question)} />
                    ) : (
                      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2Icon className="size-4 animate-spin" aria-hidden /> Checking your records…
                      </p>
                    )}
                  </motion.li>
                )}
              </AnimatePresence>
            </ol>
          )}
          {/* Kept clear of the question box (and the phone menu) when scrolled to */}
          <div ref={endRef} className="scroll-mb-44 md:scroll-mb-28" />
        </div>

        <Composer value={draft} onChange={setDraft} onSend={() => send(draft)} pending={ask.isPending} />
      </div>

      <SidePanel open={historyOpen} onOpenChange={setHistoryOpen} title="Earlier conversations">
        <ThreadList current={threadId} onOpen={openThread} disabled={ask.isPending} />
      </SidePanel>
    </div>
  );
}

function Question({ text }: { text: string }) {
  return <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">{text}</p>;
}

function ThreadList({ current, onOpen, disabled }: { current: string | null; onOpen: (id: string | null) => void; disabled: boolean }) {
  const threads = useAskThreads();
  const items = threads.data?.items ?? [];
  return (
    <nav aria-label="Earlier conversations" className="grid gap-2">
      <Button variant="secondary" size="sm" className="justify-start" onClick={() => onOpen(null)} disabled={disabled}>
        <PlusIcon aria-hidden /> New conversation
      </Button>
      {threads.isPending ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">Your conversations will be listed here. Only you can see them.</p>
      ) : (
        <ul className="grid gap-0.5">
          {items.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                disabled={disabled}
                aria-current={t.id === current ? "true" : undefined}
                className={cn("grid w-full rounded-lg px-2.5 py-2 text-left hover:bg-accent disabled:opacity-50", t.id === current && "bg-accent")}
              >
                <span className="truncate text-sm">{t.title}</span>
                <span className="text-xs text-muted-foreground">{formatRelative(t.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function Answer({ message: m, latest, onFollowUp }: { message: AssistantMessage; latest: boolean; onFollowUp: (q: string) => void }) {
  const act = useAskAct();
  const [action, setAction] = useState<Action | null>(null);
  return (
    <div className="grid min-w-0 max-w-full gap-4 rounded-2xl rounded-bl-md border bg-card p-4 shadow-card sm:max-w-[95%]">
      <Worded wording={m.answer} />
      {m.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
      {m.sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">From:</span>
          {m.sources.map((s) =>
            s.href ? (
              <Link key={s.id} to={s.href} className="rounded-md border px-2 py-0.5 hover:bg-accent">
                {s.label}
              </Link>
            ) : (
              <span key={s.id} className="rounded-md border px-2 py-0.5">
                {s.label}
              </span>
            ),
          )}
        </div>
      )}
      {action ? (
        <ActionConfirmation confirmation={action} />
      ) : (
        m.suggestion && (
          <div>
            <Button
              variant="secondary"
              disabled={act.isPending}
              onClick={() => act.mutate(m.id, { onSuccess: (r) => setAction(r.action), onError: (err) => toast.error(errorMessage(err)) })}
            >
              {act.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <MailIcon aria-hidden />}
              {m.suggestion.label}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">We draft it for you to check. Nothing is sent until someone approves it.</p>
          </div>
        )
      )}
      {latest && m.follow_ups.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Follow-up questions">
          {m.follow_ups.map((f) => (
            <button key={f} type="button" onClick={() => onFollowUp(f)} className="rounded-full border px-3 py-1 text-left text-sm hover:bg-accent">
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: AskBlock }) {
  const currency = useCurrentUser().business.currency;
  if (block.type === "chart") {
    return (
      <ChartCard
        title={block.title}
        summary={`${block.title}, week by week, with the safety level.`}
        className="shadow-none"
        table={{
          columns: [
            { key: "date", label: "Week of" },
            { key: "expected", label: "Expected", numeric: true },
            { key: "range", label: "Worst to best", numeric: true },
          ],
          rows: block.points.map((p) => ({
            id: p.date,
            date: formatDate(p.date, true),
            expected: <Money minor={p.expected_minor} currency={currency} />,
            range: (
              <>
                <Money minor={p.worst_minor} currency={currency} /> – <Money minor={p.best_minor} currency={currency} />
              </>
            ),
          })),
        }}
      >
        <CashAreaChart series={block.points} currency={currency} height={180} safetyLevelMinor={block.safety_level_minor} />
      </ChartCard>
    );
  }
  if (block.rows.length === 0) return null;
  return (
    <figure aria-label={block.title} className="grid min-w-0 gap-2">
      <figcaption className="text-sm font-medium">{block.title}</figcaption>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              {block.columns.map((c, i) => (
                <th key={c} scope="col" className={cn("px-3 py-2 font-medium", block.money_columns.includes(i) && "text-right")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-0">
                {row.map((cell, i) =>
                  block.money_columns.includes(i) && typeof cell === "number" ? (
                    <td key={i} className="whitespace-nowrap px-3 py-2 text-right tabular">
                      <Money minor={cell} currency={currency} />
                    </td>
                  ) : i === 0 ? (
                    <th key={i} scope="row" className="px-3 py-2 text-left font-normal">
                      {cell ?? "–"}
                    </th>
                  ) : (
                    <td key={i} className="px-3 py-2">
                      {cell ?? "–"}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

function Composer({ value, onChange, onSend, pending }: { value: string; onChange: (v: string) => void; onSend: () => void; pending: boolean }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const Speech = speechRecognition();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSend();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };
  const toggleVoice = () => {
    if (!Speech) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Speech();
    rec.lang = "en-GB";
    rec.interimResults = false;
    rec.onresult = (e) => onChange(Array.from(e.results, (r) => r[0]?.transcript ?? "").join(" "));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  return (
    <form onSubmit={onSubmit} className="sticky bottom-20 flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-panel md:bottom-4">
      <label htmlFor="ask-input" className="sr-only">
        Ask a question
      </label>
      <Textarea
        id="ask-input"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about your business…"
        className="max-h-40 min-h-10 flex-1 border-0 shadow-none focus-visible:outline-none"
        maxLength={1000}
      />
      {Speech && (
        <Button type="button" variant="ghost" size="icon" onClick={toggleVoice} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Ask by voice"}>
          <MicIcon className={cn(listening && "text-danger")} aria-hidden />
        </Button>
      )}
      <Button type="submit" size="icon" disabled={!value.trim() || pending} aria-label="Send question">
        {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : <ArrowUpIcon aria-hidden />}
      </Button>
    </form>
  );
}
