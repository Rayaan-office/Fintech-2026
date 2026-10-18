import { ChevronRightIcon, CircleCheckIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { TodayItem } from "@/api/types";
import { Section } from "@/components/kit";
import { StatusDot } from "@/components/StatusDot";
import { RANK } from "./SummaryTiles";

const SHOWN = 3; // more than this folds behind "Show more"

/** What needs the person today, most pressing first: a dot, a short line and the next step. */
export function TodayList({ items }: { items: TodayItem[] }) {
  const [all, setAll] = useState(false);
  // Most pressing first; the server's order is kept within each level
  const sorted = [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  return (
    <Section title="Today" aside={items.length > 0 ? items.length : undefined}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-positive" aria-hidden />
          Nothing needs you today.
        </p>
      ) : (
        <div>
          <ul className="divide-y border-y">
            {shown.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5 sm:gap-4">
                <StatusDot
                  status={item.severity === "urgent" ? "danger" : item.severity === "attention" ? "warning" : "accent"}
                  label={item.severity === "urgent" ? "Urgent" : item.severity === "attention" ? "Needs attention" : "For your information"}
                  className="w-2 justify-center"
                />
                <p className="min-w-0 flex-1 text-sm">{item.sentence}</p>
                <Link
                  to={item.href}
                  className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent max-sm:px-2"
                >
                  {item.action_label}
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          {sorted.length > SHOWN && (
            <button type="button" className="mt-2 text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show ${sorted.length - SHOWN} more`}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
