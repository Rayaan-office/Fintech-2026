import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, FileTextIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDocuments, useUploadDocument } from "@/api/hooks";
import type { DocumentSummary } from "@/api/types";
import { DOCUMENT_STATUS, DocumentReview, isReading, ReadingStatus } from "@/components/DocumentReview";
import { Initials } from "@/components/Initials";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UploadDropzone } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

// What the server accepts; it checks each file's contents again
export const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/tiff,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,.xlsx";
const HINT = "PDF, photo or spreadsheet, up to 15 MB. Personal details are hidden before the AI reads anything.";

const SOURCE: Record<DocumentSummary["source"], string> = { email: "by email", upload: "uploaded", photo: "photo", statement: "statement" };
const TYPE: Record<string, string> = { bill: "Bill", invoice: "Invoice", receipt: "Receipt", payment_notice: "Payment notice", credit_note: "Credit note", other: "Document" };

type Filter = "all" | "review" | "awaiting_approval" | "reading";
const matches = (d: DocumentSummary, f: Filter) => f === "all" || (f === "reading" ? isReading(d.status) : d.status === f);

export default function DocumentsPage() {
  const docs = useDocuments();
  const upload = useUploadDocument();
  const [params, setParams] = useSearchParams();
  const showUpload = params.get("upload") === "1";
  const setShowUpload = (on: boolean) =>
    setParams(
      (p) => {
        if (on) p.set("upload", "1");
        else p.delete("upload");
        return p;
      },
      { replace: true },
    );

  const onFiles = async (files: File[], fromCamera: boolean) => {
    for (const file of files) {
      try {
        await upload.mutateAsync({ file, source: fromCamera ? "photo" : "upload" });
        toast.success(`${file.name} received. We're reading it now.`);
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
  };

  const dropzone = <UploadDropzone onFiles={(f, cam) => void onFiles(f, cam)} pending={upload.isPending} accept={ACCEPT} hint={HINT} camera />;

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Documents"
        description="Bills, invoices, receipts and statements, with what we found in each."
        actions={
          <>
            <PhoneHandoff />
            <Button onClick={() => setShowUpload(!showUpload)} aria-expanded={showUpload}>
              <UploadIcon aria-hidden /> Upload
            </Button>
          </>
        }
      />
      {showUpload && dropzone}
      <QueryView
        query={docs}
        loading={<ListSkeleton rows={6} />}
        empty={<NoDocuments />}
      >
        {(data) => (data.items.length === 0 ? (showUpload ? <NoDocuments /> : dropzone) : <DocumentTable items={data.items} />)}
      </QueryView>
    </div>
  );
}

function NoDocuments() {
  return <EmptyState icon={FileTextIcon} title="No documents yet" description="Bills that arrive in your bills inbox appear here automatically. You can also upload one." />;
}

const col = createColumnHelper<DocumentSummary>();

function DocumentStatusCell({ doc: d }: { doc: DocumentSummary }) {
  if (isReading(d.status)) return <ReadingStatus stage={d.stage} />;
  const s = DOCUMENT_STATUS[d.status] ?? { status: "neutral", label: d.status };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusDot status={s.status} label={s.label} showLabel className="whitespace-nowrap" />
      {d.warnings.length > 0 && (
        <Badge variant="danger" title={d.warnings.map((w) => w.label).join(", ")}>
          <TriangleAlertIcon aria-hidden /> {d.warnings.length === 1 ? d.warnings[0]!.label : `${d.warnings.length} warnings`}
        </Badge>
      )}
    </span>
  );
}

function DocumentTable({ items }: { items: DocumentSummary[] }) {
  const currency = useCurrentUser().business.currency;
  const [filter, setFilter] = useState<Filter>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);
  // ?open=<id> opens a document directly (links from approval cards)
  const [params, setParams] = useSearchParams();
  const openId = params.get("open");
  const setOpenId = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set("open", id);
        else p.delete("open");
        return p;
      },
      { replace: true },
    );
  const open = items.find((d) => d.id === openId) ?? null;

  const rows = useMemo(() => items.filter((d) => matches(d, filter)), [items, filter]);
  const columns = useMemo(
    () => [
      col.accessor((d) => d.counterparty ?? d.filename, {
        id: "document",
        header: "Document",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="flex min-w-0 items-center gap-3">
              {d.counterparty ? <Initials name={d.counterparty} /> : <FileTextIcon className="size-8 shrink-0 p-1.5 text-muted-foreground" aria-hidden />}
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.counterparty ?? d.filename}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {TYPE[d.doc_type ?? ""] ?? "Document"} · {SOURCE[d.source] ?? d.source}
                  {d.counterparty && ` · ${d.filename}`}
                </span>
              </span>
            </span>
          );
        },
      }),
      col.accessor("created_at", { header: "Received", cell: (c) => <span className="whitespace-nowrap text-muted-foreground">{formatRelative(c.getValue())}</span> }),
      col.accessor("total_minor", {
        header: "Total",
        sortUndefined: "last",
        cell: (c) => {
          const v = c.getValue();
          return v === null ? <span className="text-muted-foreground">—</span> : <Money minor={v} currency={c.row.original.currency || currency} />;
        },
        meta: { numeric: true },
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => <DocumentStatusCell doc={row.original} />,
      }),
    ],
    [currency],
  );

  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  return (
    <>
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="review">Needs a check</TabsTrigger>
          <TabsTrigger value="awaiting_approval">Waiting</TabsTrigger>
          <TabsTrigger value="reading">Reading</TabsTrigger>
        </TabsList>
      </Tabs>
      {/* Phones get a simple list; the table needs more width */}
      <ul aria-label="Documents" className="divide-y rounded-xl border bg-card shadow-card sm:hidden">
        {table.getRowModel().rows.map(({ original: d }) => (
          <li key={d.id}>
            <button type="button" className={cn("flex w-full items-start gap-3 px-4 py-3 text-left", d.id === openId && "bg-accent/70")} onClick={() => setOpenId(d.id)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{d.counterparty ?? d.filename}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {TYPE[d.doc_type ?? ""] ?? "Document"} · {formatRelative(d.created_at)}
                </span>
                <span className="mt-1 block">
                  <DocumentStatusCell doc={d} />
                </span>
              </span>
              {d.total_minor !== null && <Money minor={d.total_minor} currency={d.currency || currency} className="text-sm font-medium" />}
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing here with this filter.</li>}
      </ul>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-card max-sm:hidden">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b text-left text-xs text-muted-foreground">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const numeric = (h.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric;
                  return (
                    <th key={h.id} scope="col" className={cn("px-4 py-2.5 font-medium", numeric && "text-right")} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === "asc" && <ArrowUpIcon className="size-3" aria-hidden />}
                        {sorted === "desc" && <ArrowDownIcon className="size-3" aria-hidden />}
                      </button>
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
                className={cn("cursor-pointer border-b last:border-0 hover:bg-accent/60", row.original.id === openId && "bg-accent/70")}
                onClick={() => setOpenId(row.original.id)}
              >
                {row.getVisibleCells().map((cell, i) => (
                  <td key={cell.id} className={cn("px-4 py-3", (cell.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric && "text-right")}>
                    {i === 0 ? (
                      <button type="button" className="w-full text-left" onClick={(e) => { e.stopPropagation(); setOpenId(row.original.id); }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </button>
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing here with this filter.</p>}
      </div>

      <FocusedPanel open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} title={open ? (open.counterparty ?? open.filename) : ""} description={open?.filename}>
        {open && <DocumentReview id={open.id} onDone={() => setOpenId(null)} />}
      </FocusedPanel>
    </>
  );
}
