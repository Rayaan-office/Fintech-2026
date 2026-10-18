import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/api/auth";
import type { CashWarning } from "@/api/types";
import { InfoPopover } from "@/components/kit";
import { cn } from "@/lib/utils";

/** What to do next: one compact row per warning, the reasoning one click away. */
export function Warnings({ warnings }: { warnings: CashWarning[] }) {
  const can = useCan();
  return (
    <section aria-labelledby="warnings-heading">
      <h2 id="warnings-heading" className="sr-only">
        Warnings
      </h2>
      {warnings.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-positive" aria-hidden />
          No warnings: cash stays above your safety level, even if customers pay late.
        </p>
      ) : (
        <ul className="divide-y border-y">
          {warnings.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              {w.severity === "info" ? (
                <InfoIcon className="size-4 shrink-0 text-primary" aria-label="Worth watching" />
              ) : (
                <TriangleAlertIcon
                  className={cn("size-4 shrink-0", w.severity === "urgent" ? "text-danger" : "text-warning")}
                  aria-label={w.severity === "urgent" ? "Urgent" : "Needs attention"}
                />
              )}
              <p className="min-w-0 flex-1 basis-[14rem] text-sm">{w.sentence}</p>
              <InfoPopover label="Why am I seeing this?" title="Why we're warning you" className="shrink-0">
                <p>{w.why}</p>
              </InfoPopover>
              {w.grade !== "watch" && can("use_financing") && (
                <Link
                  to="/financing"
                  className="inline-flex h-8 shrink-0 items-center rounded-full bg-secondary px-3 text-[13px] font-medium transition-colors hover:bg-accent"
                >
                  Ways to cover it
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
