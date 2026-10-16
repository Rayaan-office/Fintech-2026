import { ChevronDownIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const PLACEHOLDER = /(\[[A-Z][A-Z0-9_]*_\d+\])/g;

/** Redacted text with placeholders such as [BANK_ACCOUNT_1] shown as chips. Plain text only. */
export function RedactedText({ text }: { text: string }) {
  const pieces = text.split(PLACEHOLDER);
  return (
    <>
      {pieces.map((piece, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            data-placeholder
            className="mx-px inline-flex items-center rounded border border-primary/20 bg-primary-soft px-1 py-px font-mono text-[0.85em] text-primary"
          >
            {piece}
          </span>
        ) : (
          piece
        ),
      )}
    </>
  );
}

export type AiTextProps = {
  /** The AI's answer. Rendered as text, never as HTML. */
  text: string;
  /** Exactly what was sent to the AI, with personal details replaced by placeholders. */
  redactedInput: string;
  label?: string;
  className?: string;
};

export function AiText({ text, redactedInput, label = "Checked against your records", className }: AiTextProps) {
  return (
    <div className={cn("grid gap-2", className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <SparklesIcon className="size-3.5 text-primary" aria-hidden />
        <span>{label}</span>
      </p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
      <WhatTheAiSaw redactedInput={redactedInput} />
    </div>
  );
}

/**
 * The "What the AI saw" disclosure on its own, for places where the AI's answer is shown another way.
 * "card" gives it a bordered row of its own, for review screens with several blocks.
 */
export function WhatTheAiSaw({ redactedInput, children, variant = "link" }: { redactedInput: string; children?: ReactNode; variant?: "link" | "card" }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const card = variant === "card";

  return (
    <div className={cn(card && "rounded-xl border")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={
          card
            ? "flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium hover:bg-accent/60"
            : "inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline"
        }
      >
        {card && <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden />}
        <span className={cn(card && "flex-1")}>What the AI saw</span>
        <ChevronDownIcon className={cn("size-3.5 transition-transform", card && "size-4 text-muted-foreground", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className={cn("grid gap-2", card ? "border-t px-4 py-3.5" : "mt-2 rounded-lg border bg-muted/60 p-3")}>
              <p
                className={cn("whitespace-pre-wrap break-words font-mono text-xs leading-relaxed", card && "max-h-80 overflow-y-auto rounded-lg bg-muted/60 p-3")}
                data-testid="ai-saw"
              >
                <RedactedText text={redactedInput} />
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheckIcon className="size-3.5 text-positive" aria-hidden />
                Names and numbers were replaced before sending. The AI provider keeps nothing.
              </p>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
