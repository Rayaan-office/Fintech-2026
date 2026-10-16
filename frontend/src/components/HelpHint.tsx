import { CircleHelpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Plain-words explanations of money terms, shown on hover or focus. */
export const MONEY_TERMS = {
  "Who owes you": "Invoices you've sent that customers haven't paid yet.",
  "Bills due": "Bills from suppliers that you still need to pay.",
  "Lowest point": "The least cash we expect you to have in the next 90 days.",
  "Safety level": "The cash buffer you want to keep. We warn you before you dip below it.",
  Runway: "How many months your cash would last at your current rate of spending.",
  Margin: "The share of each pound of sales you keep as profit.",
  Profit: "Sales minus costs for the period.",
  "Days to get paid": "On average, how long customers take to pay after you invoice them.",
  "Money in": "Payments you received.",
  "Money out": "Payments you made.",
  "Best to worst": "The shaded band shows how high or low cash could reasonably go.",
} as const;

export type MoneyTerm = keyof typeof MONEY_TERMS;

export function HelpHint({ term, children, className }: { term: MoneyTerm; children?: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {children ?? term}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="rounded-full text-muted-foreground/70 hover:text-foreground" aria-label={`What is “${term}”?`}>
            <CircleHelpIcon className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{MONEY_TERMS[term]}</TooltipContent>
      </Tooltip>
    </span>
  );
}
