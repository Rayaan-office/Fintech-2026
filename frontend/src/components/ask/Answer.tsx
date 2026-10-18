import { ChevronDownIcon, FileTextIcon, LayoutGridIcon, Loader2Icon, MailIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useAskAct } from "@/api/hooks";
import type { Action, AskMessage, RecordRef } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { RedactedText } from "@/components/AiText";
import { IconTile, InfoPopover } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AnswerBlock } from "./AnswerBlocks";

export type AssistantMessage = Extract<AskMessage, { role: "assistant" }>;

const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground";

/** The person's question, as a soft grey bubble on the right. */
export function Question({ text }: { text: string }) {
  return <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm">{text}</p>;
}

/** The assistant's side of a turn: a small mark on the left, the content beside it. */
function AssistantTurn({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <IconTile icon={SparklesIcon} tone="accent" className="mt-0.5 hidden size-7 sm:inline-flex [&>svg]:size-3.5" />
      <div className="grid min-w-0 flex-1 gap-4">{children}</div>
    </div>
  );
}

export function Thinking() {
  return (
    <AssistantTurn>
      <div role="status" className="grid gap-2.5 pt-1">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> Checking your records…
        </span>
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </AssistantTurn>
  );
}

export function Answer({ message: m, latest, onFollowUp }: { message: AssistantMessage; latest: boolean; onFollowUp: (q: string) => void }) {
  const act = useAskAct();
  const [action, setAction] = useState<Action | null>(null);
  const [sawOpen, setSawOpen] = useState(false);
  const sawId = useId();
  const reduce = useReducedMotion();
  const ai = m.answer.ai_written;
  const saw = ai && m.answer.redacted_input ? m.answer.redacted_input : "";

  return (
    <AssistantTurn>
      <AnswerText text={m.answer.text} />

      {m.blocks.map((b, i) => (
        <AnswerBlock key={i} block={b} />
      ))}

      {(ai || m.sources.length > 0) && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {ai && (
              <span className={cn(chip, "border-transparent bg-positive-soft text-positive")}>
                <ShieldCheckIcon className="size-3.5" aria-hidden />
                <span>Checked against your records</span>
              </span>
            )}
            {saw && (
              <button
                type="button"
                aria-expanded={sawOpen}
                aria-controls={sawId}
                onClick={() => setSawOpen((o) => !o)}
                className={cn(chip, "transition-colors hover:text-foreground", sawOpen && "border-foreground/20 text-foreground")}
              >
                <SparklesIcon className="size-3.5" aria-hidden />
                What the AI saw
                <ChevronDownIcon className={cn("size-3.5 transition-transform", sawOpen && "rotate-180")} aria-hidden />
              </button>
            )}
            <Sources sources={m.sources} />
          </div>
          <AnimatePresence initial={false}>
            {saw && sawOpen && (
              <motion.div
                id={sawId}
                initial={reduce ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={reduce ? undefined : { height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="grid gap-2 rounded-xl bg-muted/70 p-3.5">
                  <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed" data-testid="ai-saw">
                    <RedactedText text={saw} />
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheckIcon className="size-3.5 text-positive" aria-hidden />
                    Names and numbers were replaced before sending. The AI provider keeps nothing.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {action ? (
        <ActionConfirmation confirmation={action} />
      ) : (
        m.suggestion && (
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              disabled={act.isPending}
              onClick={() => act.mutate(m.id, { onSuccess: (r) => setAction(r.action), onError: (err) => toast.error(errorMessage(err)) })}
            >
              {act.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <MailIcon aria-hidden />}
              {m.suggestion.label}
            </Button>
            <InfoPopover label="About drafts">We draft it for you to check. Nothing is sent until someone approves it.</InfoPopover>
          </div>
        )
      )}

      {latest && m.follow_ups.length > 0 && (
        <div role="group" aria-label="Follow-up questions" className="flex flex-wrap gap-1.5">
          {m.follow_ups.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFollowUp(f)}
              className="rounded-full border bg-card px-3 py-1.5 text-left text-[13px] transition-colors hover:border-foreground/20 hover:bg-accent"
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </AssistantTurn>
  );
}

/** The first paragraph, with the rest one click away when the answer runs long. */
function AnswerText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const parts = text.trim().split(/\n\s*\n/);
  const long = parts.length > 1 && text.length > 320;
  const shown = long && !open ? parts[0] : text.trim();
  return (
    <div className="grid justify-items-start gap-1.5">
      <p id={id} className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
        {shown}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
          <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Where the answer came from: the first two, the rest one click away. */
function Sources({ sources }: { sources: RecordRef[] }) {
  const [all, setAll] = useState(false);
  const shown = all || sources.length <= 3 ? sources : sources.slice(0, 2);
  return (
    <>
      {shown.map((s) => (
        <Source key={s.id} source={s} />
      ))}
      {shown.length < sources.length && (
        <button type="button" onClick={() => setAll(true)} className={cn(chip, "hover:text-foreground")} aria-label={`Show ${sources.length - shown.length} more sources`}>
          +{sources.length - shown.length}
        </button>
      )}
    </>
  );
}

function Source({ source: s }: { source: RecordRef }) {
  const Icon = s.kind === "page" ? LayoutGridIcon : FileTextIcon;
  const body = (
    <>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </>
  );
  return s.href ? (
    <Link to={s.href} className={cn(chip, "transition-colors hover:text-foreground")}>
      {body}
    </Link>
  ) : (
    <span className={chip}>{body}</span>
  );
}
