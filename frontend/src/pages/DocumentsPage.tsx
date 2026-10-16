import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, FileTextIcon, UploadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDocuments, useUploadDocument } from "@/api/hooks";
import type { DocumentStatus, DocumentSummary } from "@/api/types";
import { DocumentJourney, DocumentReview } from "@/components/DocumentReview";
import { Initials } from "@/components/Initials";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { FocusedPanel } from "@/components/panels";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot, type Status } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UploadDropzone } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; status: Status }> = {
  processing: { label: "Processing", status: "accent" },
  needs_review: { label: "Needs review", status: "warning" },
  done: { label: "Done", status: "positive" },
  failed: { label: "Couldn't read", status: "danger" },
};

const ACCEPT = "application/pdf,image/jpeg,image/png,image/heic,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HINT = "PDF, photo or spreadsheet, up to 20 MB. Personal details are hidden before the AI reads anything.";

type Filter = "all" | "needs_review" | "processing";

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

  const onFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        await upload.mutateAsync(file);
        toast.success(`${file.name} received. We're reading it now.`);
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
  };

  const dropzone = <UploadDropzone onFiles={(f) => void onFiles(f)} pending={upload.isPending} accept={ACCEPT} hint={HINT} camera />;

  return (
    <div className="grid gap-6">
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

function DocumentTable({ items }: { items: DocumentSummary[] }) {
  const currency = useCurrentUser().business.currency;
  const [filter, setFilter] = useState<Filter>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "received_at", desc: true }]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((d) => d.id === openId) ?? null;

  const rows = useMemo(() => (filter === "all" ? items : items.filter((d) => d.status === filter)), [items, filter]);
  const columns = useMemo(
    () => [
      col.accessor((d) => d.counterparty ?? d.filename, {
        id: "document",
        header: "Document",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="flex min-w-0 items-center gap-3">
              {d.counterparty ? <Initials name={d.counterparty} /> : <FileTextIcon className="size-8 p-1.5 text-muted-foreground" aria-hidden />}
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.counterparty ?? d.filename}</span>
                <span className="block truncate text-xs capitalize text-muted-foreground">
                  {d.kind} · {d.source}
                </span>
              </span>
            </span>
          );
        },
      }),
      col.accessor("received_at", { header: "Received", cell: (c) => <span className="text-muted-foreground">{formatRelative(c.getValue())}</span> }),
      col.accessor("total_minor", {
        header: "Total",
        sortUndefined: "last",
        cell: (c) => {
          const v = c.getValue();
          return v === null ? <span className="text-muted-foreground">—</span> : <Money minor={v} currency={currency} />;
        },
        meta: { numeric: true },
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => {
          const d = row.original;
          return d.status === "processing" ? <DocumentJourney steps={d.steps} /> : <StatusDot status={DOCUMENT_STATUS[d.status].status} label={DOCUMENT_STATUS[d.status].label} showLabel />;
        },
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
          <TabsTrigger value="needs_review">Needs review</TabsTrigger>
          <TabsTrigger value="processing">Processing</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
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
