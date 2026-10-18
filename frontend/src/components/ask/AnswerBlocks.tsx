import { EyeOffIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useCurrentUser } from "@/api/auth";
import type { AskBlock, AskPassagesBlock } from "@/api/types";
import { ChartCard } from "@/components/ChartCard";
import { CashAreaChart } from "@/components/charts";
import { Surface } from "@/components/kit";
import { Money } from "@/components/Money";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A chart, table or set of passages our own code built from the records (never the AI). */
export function AnswerBlock({ block }: { block: AskBlock }) {
  const currency = useCurrentUser().business.currency;
  if (block.type === "chart") {
    return (
      <ChartCard
        title={block.title}
        summary={`${block.title}, week by week, with the safety level.`}
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
  if (block.type === "passages") return <Passages block={block} />;
  return <TableBlock block={block} currency={currency} />;
}

const ROWS = 5;

/** A table of figures from the records; long ones show the first few rows until asked. */
function TableBlock({ block, currency }: { block: Extract<AskBlock, { type: "table" }>; currency: string }) {
  const [all, setAll] = useState(false);
  if (block.rows.length === 0) return null;
  const rows = all ? block.rows : block.rows.slice(0, ROWS);
  return (
    <figure aria-label={block.title} className="grid min-w-0 gap-2">
      <figcaption className="text-[13px] font-medium text-muted-foreground">{block.title}</figcaption>
      <Surface className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {block.columns.map((c, i) => (
                <th key={c} scope="col" className={cn("px-4 py-2.5 font-medium", block.money_columns.includes(i) && "text-right")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-t">
                {row.map((cell, i) =>
                  block.money_columns.includes(i) && typeof cell === "number" ? (
                    <td key={i} className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular">
                      <Money minor={cell} currency={currency} />
                    </td>
                  ) : i === 0 ? (
                    <th key={i} scope="row" className="px-4 py-2.5 text-left font-normal">
                      {cell ?? "–"}
                    </th>
                  ) : (
                    <td key={i} className="px-4 py-2.5 tabular">
                      {cell ?? "–"}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {block.rows.length > ROWS && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((a) => !a)}
            className="w-full border-t px-4 py-2 text-left text-[13px] font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            {all ? "Show fewer" : `Show all ${block.rows.length}`}
          </button>
        )}
      </Surface>
    </figure>
  );
}

const HIDDEN = /(\[hidden [a-z ]+\])/;

/** Passages found in the documents, each linked to its document. Personal details stay hidden here too. */
function Passages({ block }: { block: AskPassagesBlock }) {
  if (block.items.length === 0) return null;
  return (
    <figure aria-label={block.title} className="grid min-w-0 gap-2">
      <figcaption className="text-[13px] font-medium text-muted-foreground">{block.title}</figcaption>
      <Surface>
        <ul className="divide-y">
          {block.items.map((p) => (
            <li key={p.document_id} className="grid gap-2 px-4 py-3.5">
              <blockquote className="break-words border-l-2 border-primary/40 pl-3 text-sm leading-relaxed">
                {p.text.split(HIDDEN).map((part, i) =>
                  i % 2 === 1 ? (
                    <span key={i} className="rounded bg-muted px-1 text-xs text-muted-foreground">
                      {part.slice(1, -1)}
                    </span>
                  ) : (
                    part
                  ),
                )}
              </blockquote>
              <Link to={p.href} className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline">
                <FileTextIcon className="size-3.5" aria-hidden />
                {p.label}, {p.kind} received {formatDate(p.date, true)}
              </Link>
            </li>
          ))}
        </ul>
      </Surface>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <EyeOffIcon className="size-3.5" aria-hidden />
        Quoted as the AI saw them: personal and bank details stay hidden.
      </p>
    </figure>
  );
}
