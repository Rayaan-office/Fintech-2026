import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, CalendarIcon, FileTextIcon, UploadIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDocuments, useUploadDocument } from "@/api/hooks";
import type { DocumentSummary } from "@/api/types";
import { DocumentReview, isReading } from "@/components/DocumentReview";
import { DOC_SOURCE, DocumentStatusCell, kindOf, ReadingNow, SourceIcon, TypeChip } from "@/components/documents/bits";
import { Initials } from "@/components/Initials";
import { FilterPills, Meta } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { PageDrop, UploadDropzone, UploadError, useUploadPicker } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

// What the server accepts; it checks each file's contents again
export const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/tiff,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,.xlsx";
const HINT = "PDF, photo or spreadsheet, up to 15 MB. Personal details are hidden before the AI reads anything.";

type Filter = "all" | "review" | "awaiting_approval" | "reading";
const matches = (d: DocumentSummary, f: Filter) => f === "all" || (f === "reading" ? isReading(d.status) : d.status === f);

export default function DocumentsPage() {
  const docs = useDocuments();
  const upload = useUploadDocument();
  const [params, setParams] = useSearchParams();
  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );
  // ?upload=1 opens the drop zone (links from Home and search); ?open=<id> opens a document
  const showDrop = params.get("upload") === "1";
  const openId = params.get("open");

  const onFiles = async (files: File[], fromCamera: boolean) => {
    for (const file of files) {
      try {
        await upload.mutateAsync({ file, source: fromCamera ? "photo" : "upload" });
        toast.success(`${file.name} received. We're reading it now.`);
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
    if (showDrop) setParam("upload", null);
  };
  const picker = useUploadPicker({ onFiles: (f, cam) => void onFiles(f, cam), accept: ACCEPT, camera: true });
  const items = docs.data?.items ?? [];
  const open = items.find((d) => d.id === openId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-6">
      {picker.inputs}
      <PageDrop onDrop={(files) => picker.take(files)} />
      <PageHeader
        title="Documents"
        actions={
          <>
            <PhoneHandoff className="max-sm:hidden" />
            <Button onClick={picker.pick} disabled={upload.isPending}>
              <UploadIcon aria-hidden /> Upload
            </Button>
          </>
        }
      />
      <UploadError error={picker.error} />
      {showDrop && items.length > 0 && <UploadDropzone picker={picker} pending={upload.isPending} hint={HINT} camera onClose={() => setParam("upload", null)} />}
      <QueryView query={docs} loading={<ListSkeleton rows={6} />} empty={<UploadDropzone picker={picker} pending={upload.isPending} hint={HINT} camera />}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty>
              <UploadDropzone picker={picker} pending={upload.isPending} hint={HINT} camera />
            </Empty>
          ) : (
            <DocumentTable items={data.items} openId={openId} onOpen={(id) => setParam("open", id)} />
          )
        }
      </QueryView>

      <FocusedPanel
        open={openId !== null}
        onOpenChange={(o) => !o && setParam("open", null)}
        title={open ? (open.counterparty ?? open.filename) : "Document"}
        description={open ? <PanelMeta doc={open} /> : undefined}
      >
        {openId && <DocumentReview id={openId} onDone={() => setParam("open", null)} />}
      </FocusedPanel>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-3">
      {children}
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileTextIcon className="size-4" aria-hidden /> Bills sent to your bills inbox appear here by themselves.
      </p>
    </div>
  );
}

/** Kind, source and when, under the panel title. The file name is in the panel itself. */
function PanelMeta({ doc: d }: { doc: DocumentSummary }) {
  const kind = kindOf(d);
  const source = DOC_SOURCE[d.source];
  return (
    <Meta
      className="mt-1"
      items={[
        kind && { icon: kind.icon, label: kind.label },
        source && { icon: source.icon, label: source.label },
        { icon: CalendarIcon, label: formatRelative(d.created_at) },
      ]}
    />
  );
}

const col = createColumnHelper<DocumentSummary>();
type ColMeta = { numeric?: boolean; className?: string };

function DocumentTable({ items, openId, onOpen }: { items: DocumentSummary[]; openId: string | null; onOpen: (id: string) => void }) {
  const currency = useCurrentUser().business.currency;
  const [filter, setFilter] = useState<Filter>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);

  const counts = useMemo(() => {
    const c = { all: items.length, review: 0, awaiting_approval: 0, reading: 0 } as Record<Filter, number>;
    for (const d of items) for (const f of ["review", "awaiting_approval", "reading"] as const) if (matches(d, f)) c[f] += 1;
    return c;
  }, [items]);
  const rows = useMemo(() => items.filter((d) => matches(d, filter)), [items, filter]);
  const reading = useMemo(() => items.filter((d) => isReading(d.status)), [items]);

  const columns = useMemo(
    () => [
      col.accessor((d) => d.counterparty ?? d.filename, {
        id: "party",
        header: "Party",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-3 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d.id);
              }}
            >
              {d.counterparty ? <Initials name={d.counterparty} /> : <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><FileTextIcon className="size-4 text-muted-foreground" aria-hidden /></span>}
              <span className="min-w-0 truncate font-medium">{d.counterparty ?? d.filename}</span>
              {/* The file name stays findable (and in the row's name) without taking a line */}
              {d.counterparty && <span className="sr-only">, {d.filename}</span>}
            </button>
          );
        },
        meta: { className: "w-[34%]" } satisfies ColMeta,
      }),
      col.accessor((d) => d.doc_type ?? "", { id: "type", header: "Type", cell: ({ row }) => <TypeChip doc={row.original} /> }),
      col.accessor("source", { header: "Source", cell: (c) => <SourceIcon source={c.getValue()} />, enableSorting: false }),
      col.accessor("created_at", {
        header: "Received",
        cell: (c) => (
          <time dateTime={c.getValue()} className="whitespace-nowrap text-muted-foreground">
            {formatRelative(c.getValue())}
          </time>
        ),
      }),
      col.accessor("total_minor", {
        header: "Amount",
        sortUndefined: "last",
        cell: (c) => {
          const v = c.getValue();
          return v === null ? <span className="text-muted-foreground">—</span> : <Money minor={v} currency={c.row.original.currency || currency} className="font-medium" />;
        },
        meta: { numeric: true } satisfies ColMeta,
      }),
      col.accessor("status", { header: "Status", cell: ({ row }) => <DocumentStatusCell doc={row.original} /> }),
    ],
    [currency, onOpen],
  );

  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  return (
    <>
      <ReadingNow docs={reading} onOpen={onOpen} />
      <FilterPills
        label="Show"
        value={filter}
        onChange={setFilter}
        // Empty filters stay out of the way
        options={(
          [
            { value: "all", label: "All", count: counts.all },
            { value: "review", label: "Needs a check", count: counts.review },
            { value: "awaiting_approval", label: "Waiting", count: counts.awaiting_approval },
            { value: "reading", label: "Reading", count: counts.reading },
          ] as const
        ).filter((o) => o.value === "all" || o.count > 0 || o.value === filter)}
      />
      {/* Phones get a simple list; the table needs more width */}
      <ul aria-label="Documents" className="divide-y rounded-xl border bg-card sm:hidden">
        {table.getRowModel().rows.map(({ original: d }) => (
          <li key={d.id}>
            <button type="button" className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", d.id === openId && "bg-accent/70")} onClick={() => onOpen(d.id)}>
              {d.counterparty ? <Initials name={d.counterparty} /> : <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><FileTextIcon className="size-4 text-muted-foreground" aria-hidden /></span>}
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm font-medium">{d.counterparty ?? d.filename}</span>
                <DocumentStatusCell doc={d} plain />
              </span>
              <span className="grid shrink-0 justify-items-end gap-0.5">
                {d.total_minor !== null && <Money minor={d.total_minor} currency={d.currency || currency} className="text-sm font-medium" />}
                <span className="text-xs text-muted-foreground">{formatRelative(d.created_at)}</span>
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing here with this filter.</li>}
      </ul>
      <div className="relative min-w-0 overflow-x-auto rounded-xl border bg-card max-sm:hidden">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b text-left text-xs text-muted-foreground">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const meta = h.column.columnDef.meta as ColMeta | undefined;
                  const label = flexRender(h.column.columnDef.header, h.getContext());
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      className={cn("px-4 py-2.5 font-medium", meta?.numeric && "text-right", meta?.className)}
                      aria-sort={!h.column.getCanSort() ? undefined : sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                    >
                      {h.column.getCanSort() ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={h.column.getToggleSortingHandler()}>
                          {label}
                          {sorted === "asc" && <ArrowUpIcon className="size-3" aria-hidden />}
                          {sorted === "desc" && <ArrowDownIcon className="size-3" aria-hidden />}
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn("cursor-pointer border-b transition-colors last:border-0 hover:bg-accent/50", row.original.id === openId && "bg-accent/70")}
                onClick={() => onOpen(row.original.id)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cn("px-4 py-3", (cell.column.columnDef.meta as ColMeta | undefined)?.numeric && "text-right")}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing here with this filter.</p>}
      </div>
    </>
  );
}
