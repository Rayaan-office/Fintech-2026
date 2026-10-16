import { ArrowUpIcon, Loader2Icon, MicIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { ApiError, errorMessage } from "@/api/client";
import { useAsk } from "@/api/hooks";
import type { AskReply } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { AiText } from "@/components/AiText";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "How is the business doing this quarter?",
  "What is my cash flow looking like next month?",
  "Which supplier costs me the most, and has that changed?",
  "Who owes me the most, and who pays late?",
  "Can I afford a new van next month?",
];

type Turn = { id: string; question: string; reply: AskReply | null; error: string | null };

export default function AskPage() {
  const ask = useAsk();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  const send = (question: string) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, question: q, reply: null, error: null }]);
    setDraft("");
    ask.mutate(q, {
      onSuccess: (reply) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, reply } : x))),
      onError: (err) =>
        setTurns((t) =>
          t.map((x) =>
            x.id === id
              ? { ...x, error: err instanceof ApiError && err.status === 404 ? "The assistant isn't switched on for this business yet. Please try again later." : errorMessage(err) }
              : x,
          ),
        ),
    });
  };

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-3xl flex-col gap-6">
      <PageHeader title="Ask" description="Questions about your business, answered from your own records." />

      <div className="flex-1">
        {turns.length === 0 ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border bg-card px-3 py-1.5 text-left text-sm shadow-card hover:bg-accent">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="grid gap-6" aria-live="polite">
            <AnimatePresence initial={false}>
              {turns.map((turn) => (
                <motion.li key={turn.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="grid gap-3">
                  <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">{turn.question}</p>
                  {turn.error ? (
                    <ErrorState message={turn.error} />
                  ) : turn.reply ? (
                    <Answer reply={turn.reply} onFollowUp={send} />
                  ) : (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2Icon className="size-4 animate-spin" aria-hidden /> Checking your records…
                    </p>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <Composer value={draft} onChange={setDraft} onSend={() => send(draft)} pending={ask.isPending} />
    </div>
  );
}

function Answer({ reply, onFollowUp }: { reply: AskReply; onFollowUp: (q: string) => void }) {
  return (
    <div className="grid max-w-[95%] gap-3 rounded-2xl rounded-bl-md border bg-card p-4 shadow-card">
      <AiText text={reply.answer.text} redactedInput={reply.answer.redacted_input} />
      {reply.sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">From:</span>
          {reply.sources.map((s) =>
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
      {reply.confirmation && <ActionConfirmation confirmation={reply.confirmation} />}
      {reply.follow_ups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {reply.follow_ups.map((f) => (
            <button key={f} type="button" onClick={() => onFollowUp(f)} className="rounded-full border px-3 py-1 text-sm hover:bg-accent">
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
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
        placeholder="Ask about cash, bills, customers or suppliers…"
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
