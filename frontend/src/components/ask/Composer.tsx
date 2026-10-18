import { ArrowUpIcon, Loader2Icon, MicIcon } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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

/**
 * The question box. "hero" sits in the middle of an empty page; "dock" is the compact one kept at
 * the bottom of a conversation.
 */
export function Composer({
  value,
  onChange,
  onSend,
  pending,
  variant = "dock",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  pending: boolean;
  variant?: "hero" | "dock";
}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const Speech = speechRecognition();
  const hero = variant === "hero";

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
    <form
      onSubmit={onSubmit}
      className={cn(
        "flex w-full items-end gap-1.5 rounded-3xl border bg-card p-2 pl-3 shadow-card transition-shadow focus-within:border-foreground/20 focus-within:shadow-panel focus-within:ring-2 focus-within:ring-ring/25",
        hero && "min-h-28 flex-col items-stretch",
      )}
    >
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
        className={cn("max-h-40 min-h-10 flex-1 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:outline-none", hero && "text-[15px]")}
        maxLength={1000}
      />
      <div className="flex shrink-0 items-center justify-end gap-1">
        {Speech && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={toggleVoice}
            aria-pressed={listening}
            aria-label={listening ? "Stop listening" : "Ask by voice"}
          >
            <MicIcon className={cn(listening && "text-danger")} aria-hidden />
          </Button>
        )}
        <Button type="submit" size="icon" disabled={!value.trim() || pending} aria-label="Send question">
          {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : <ArrowUpIcon aria-hidden />}
        </Button>
      </div>
    </form>
  );
}
