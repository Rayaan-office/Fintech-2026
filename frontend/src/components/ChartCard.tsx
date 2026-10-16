import { ChartAreaIcon, TableIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChartTable = {
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: ({ id: string } & Record<string, ReactNode>)[];
};

/** Every chart has a table view, one click away. */
export function ChartCard({
  title,
  summary,
  table,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  /** One sentence describing the chart for screen readers. */
  summary: string;
  table: ChartTable;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"graph" | "table">("graph");
  return (
    <section className={cn("rounded-xl border bg-card shadow-card", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <h2 className="text-sm font-medium">{title}</h2>
        <div className="flex items-center gap-2">
          {actions}
          <div role="group" aria-label="Chart view" className="inline-flex rounded-lg bg-muted p-0.5">
            <ViewButton active={view === "graph"} onClick={() => setView("graph")} label="Graph">
              <ChartAreaIcon className="size-4" aria-hidden />
            </ViewButton>
            <ViewButton active={view === "table"} onClick={() => setView("table")} label="Table">
              <TableIcon className="size-4" aria-hidden />
            </ViewButton>
          </div>
        </div>
      </header>
      <div className="px-2 pb-4 pt-2 sm:px-3">
        {view === "graph" ? (
          <div role="img" aria-label={summary}>
            {children}
          </div>
        ) : (
          <DataTable table={table} caption={summary} />
        )}
      </div>
    </section>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground",
        active && "bg-card text-foreground shadow-card",
      )}
    >
      {children}
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
}

export function DataTable({ table, caption }: { table: ChartTable; caption: string }) {
  return (
    <div className="max-h-80 overflow-auto px-3">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-left text-xs text-muted-foreground">
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-2 py-2 font-medium", c.numeric && "text-right")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              {table.columns.map((c) => (
                <td key={c.key} className={cn("px-2 py-2", c.numeric && "text-right tabular")}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
