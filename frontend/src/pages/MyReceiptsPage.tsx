import { ReceiptIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDocuments, useUploadDocument } from "@/api/hooks";
import type { DocumentStatus } from "@/api/types";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot, type Status } from "@/components/StatusDot";
import { UploadDropzone } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";

// Plain words for someone who only sends receipts in
const RECEIPT_STATUS: Record<DocumentStatus, { label: string; status: Status }> = {
  received: { label: "Reading", status: "accent" },
  queued: { label: "Reading", status: "accent" },
  processing: { label: "Reading", status: "accent" },
  review: { label: "Being checked", status: "warning" },
  awaiting_approval: { label: "Waiting for approval", status: "accent" },
  approved: { label: "Accepted", status: "positive" },
  rejected: { label: "Not accepted", status: "neutral" },
};

export default function MyReceiptsPage() {
  const currency = useCurrentUser().business.currency;
  // The server returns only the documents this person sent in
  const receipts = useDocuments();
  const submit = useUploadDocument();

  const onFiles = async (files: File[], fromCamera: boolean) => {
    for (const file of files) {
      try {
        await submit.mutateAsync({ file, source: fromCamera ? "photo" : "upload" });
        toast.success("Receipt sent. You'll see it below once it's read.");
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
  };

  return (
    <div className="mx-auto grid max-w-2xl grid-cols-1 gap-6">
      <PageHeader title="My receipts" description="Send in receipts for work expenses. Take a photo or upload a file." actions={<PhoneHandoff />} />
      <UploadDropzone
        onFiles={(f, cam) => void onFiles(f, cam)}
        pending={submit.isPending}
        accept="application/pdf,image/jpeg,image/png,image/webp"
        hint="A photo or PDF, up to 15 MB. Personal details are hidden before the AI reads anything."
        camera
      />
      <section aria-labelledby="mine-heading" className="grid gap-3">
        <h2 id="mine-heading" className="text-sm font-medium">
          Sent so far
        </h2>
        <QueryView
          query={receipts}
          loading={<ListSkeleton rows={3} />}
          empty={<EmptyState icon={ReceiptIcon} title="No receipts yet" description="Receipts you send will appear here so you can see when they've been processed." />}
        >
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={ReceiptIcon} title="No receipts yet" description="Receipts you send will appear here so you can see when they've been processed." />
            ) : (
              <ul aria-labelledby="mine-heading" className="divide-y rounded-xl border bg-card shadow-card">
                <AnimatePresence initial={false}>
                  {data.items.map((r) => (
                    <motion.li key={r.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.counterparty ?? r.filename}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatRelative(r.created_at)}
                          {r.counterparty && ` · ${r.filename}`}
                        </p>
                      </div>
                      {r.total_minor !== null && <Money minor={r.total_minor} currency={r.currency || currency} className="text-sm" />}
                      <StatusDot
                        status={RECEIPT_STATUS[r.status]?.status ?? "neutral"}
                        label={RECEIPT_STATUS[r.status]?.label ?? r.status}
                        pulse={RECEIPT_STATUS[r.status]?.label === "Reading"}
                        showLabel
                        className="shrink-0 justify-end sm:w-40"
                      />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )
          }
        </QueryView>
      </section>
    </div>
  );
}
