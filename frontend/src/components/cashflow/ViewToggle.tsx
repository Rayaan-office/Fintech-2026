import { ChartAreaIcon, TableIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChartView = "graph" | "table";

/** The small graph/table switch every chart carries, so the numbers are one click away. */
export function ViewToggle({ value, onChange, className }: { value: ChartView; onChange: (v: ChartView) => void; className?: string }) {
  return (
    <div role="group" aria-label="Chart view" className={cn("inline-flex rounded-full bg-muted p-0.5", className)}>
      <ViewButton active={value === "graph"} onClick={() => onChange("graph")} label="Graph">
        <ChartAreaIcon className="size-4" aria-hidden />
      </ViewButton>
      <ViewButton active={value === "table"} onClick={() => onChange("table")} label="Table">
        <TableIcon className="size-4" aria-hidden />
      </ViewButton>
    </div>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={label}
      className={cn(
        "inline-flex h-7 items-center rounded-full px-2.5 text-muted-foreground transition-colors hover:text-foreground",
        active && "bg-card text-foreground shadow-card",
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** A legend entry: a small swatch and a word, so colour is never the only signal. */
export function LegendKey({ swatch, children }: { swatch: "line" | "band" | "dashed" | "safety" | "dot"; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {swatch === "line" && <span className="h-0.5 w-3.5 rounded-full bg-primary" aria-hidden />}
      {swatch === "band" && <span className="h-2.5 w-3.5 rounded-sm bg-[var(--chart-band)]" aria-hidden />}
      {swatch === "dashed" && <span className="w-3.5 border-t-[1.5px] border-dashed border-muted-foreground" aria-hidden />}
      {swatch === "safety" && <span className="w-3.5 border-t-[1.5px] border-dashed border-warning" aria-hidden />}
      {swatch === "dot" && <span className="size-2 rounded-full bg-primary" aria-hidden />}
      {children}
    </span>
  );
}
