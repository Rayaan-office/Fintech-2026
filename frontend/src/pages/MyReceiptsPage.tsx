import { ReceiptIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useMyReceipts, useSubmitReceipt } from "@/api/hooks";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { StatusDot } from "@/components/StatusDot";
import { UploadDropzone } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";
import { DOCUMENT_STATUS } from "./DocumentsPage";

export default function MyReceiptsPage() {
  const currency = useCurrentUser().business.currency;
  const receipts = useMyReceipts();
  const submit = useSubmitReceipt();

  const onFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        await submit.mutateAsync(file);
        toast.success("Receipt sent. You'll see it below once it's read.");
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
  };

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <PageHeader title="My receipts" description="Send in receipts for work expenses. Take a photo or upload a file." actions={<PhoneHandoff />} />
      <UploadDropzone
        onFiles={(f) => void onFiles(f)}
        pending={submit.isPending}
        accept="application/pdf,image/jpeg,image/png,image/heic"
        hint="A photo or PDF, up to 20 MB."
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
              <ul className="divide-y rounded-xl border bg-card shadow-card">
                <AnimatePresence initial={false}>
                  {data.items.map((r) => (
                    <motion.li key={r.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.merchant ?? r.filename}</p>
                        <p className="text-xs text-muted-foreground">{formatRelative(r.submitted_at)}</p>
                      </div>
                      {r.total_minor !== null && <Money minor={r.total_minor} currency={currency} className="text-sm" />}
                      <StatusDot status={DOCUMENT_STATUS[r.status].status} label={DOCUMENT_STATUS[r.status].label} showLabel className="w-28 justify-end" />
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
