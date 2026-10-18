import { CameraIcon, ReceiptIcon, UploadIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDocuments, useUploadDocument } from "@/api/hooks";
import type { DocumentStatus, DocumentSummary } from "@/api/types";
import { DOC_SOURCE, Tip } from "@/components/documents/bits";
import { Initials } from "@/components/Initials";
import { Section, StatStrip } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { StatusDot, type Status } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { PageDrop, UploadDropzone, UploadError, useUploadPicker } from "@/components/UploadDropzone";
import { formatRelative } from "@/lib/format";

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const HINT = "A photo or PDF, up to 15 MB. Personal details are hidden before the AI reads anything.";

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
  const picker = useUploadPicker({ onFiles: (f, cam) => void onFiles(f, cam), accept: ACCEPT, camera: true });
  const dropzone = <UploadDropzone picker={picker} pending={submit.isPending} hint={HINT} camera />;

  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-8">
      {picker.inputs}
      <PageDrop onDrop={(files) => picker.take(files)} label="Drop to send" />
      <div className="grid gap-2">
        <PageHeader
          title="My receipts"
          actions={
            <>
              <PhoneHandoff className="max-sm:hidden" />
              <Button variant="secondary" onClick={picker.photo} disabled={submit.isPending} className="sm:hidden">
                <CameraIcon aria-hidden /> Photo
              </Button>
              <Button onClick={picker.pick} disabled={submit.isPending}>
                <UploadIcon aria-hidden /> Send a receipt
              </Button>
            </>
          }
        />
        <UploadError error={picker.error} />
      </div>
      <QueryView query={receipts} loading={<ListSkeleton rows={3} />} empty={dropzone}>
        {(data) => (data.items.length === 0 ? dropzone : <Receipts items={data.items} currency={currency} />)}
      </QueryView>
    </div>
  );
}

function Receipts({ items, currency }: { items: DocumentSummary[]; currency: string }) {
  const reduce = useReducedMotion();
  const [all, setAll] = useState(false);
  const visible = all ? items : items.slice(0, 5);
  const accepted = items.filter((r) => r.status === "approved");
  const waiting = items.length - accepted.length - items.filter((r) => r.status === "rejected").length;
  const acceptedTotal = accepted.reduce((s, r) => s + (r.total_minor ?? 0), 0);
  return (
    <>
      <StatStrip
        items={[
          { label: "Accepted", value: <Money minor={acceptedTotal} currency={currency} />, note: `${accepted.length} ${accepted.length === 1 ? "receipt" : "receipts"}` },
          { label: "In progress", value: waiting },
        ]}
      />
      <Section className="grid-cols-1" id="mine-heading" title="Sent so far">
        <ul aria-labelledby="mine-heading" className="divide-y rounded-xl border bg-card">
          <AnimatePresence initial={false}>
            {visible.map((r) => {
              const s = RECEIPT_STATUS[r.status] ?? { label: r.status, status: "neutral" as const };
              const source = DOC_SOURCE[r.source];
              const SourceIcon = source?.icon ?? ReceiptIcon;
              return (
                <motion.li key={r.id} layout={!reduce} initial={reduce ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 px-4 py-3">
                  {r.counterparty ? (
                    <Initials name={r.counterparty} />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <ReceiptIcon className="size-4 text-muted-foreground" aria-hidden />
                    </span>
                  )}
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="truncate text-sm font-medium">{r.counterparty ?? r.filename}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Tip tip={source?.label ?? "Sent in"}>
                        <SourceIcon className="size-3.5" aria-hidden />
                        <span className="sr-only">{source?.label}</span>
                      </Tip>
                      {formatRelative(r.created_at)}
                    </p>
                  </div>
                  <div className="grid shrink-0 justify-items-end gap-0.5">
                    {r.total_minor !== null && <Money minor={r.total_minor} currency={r.currency || currency} className="text-sm font-medium" />}
                    <StatusDot status={s.status} label={s.label} pulse={s.label === "Reading"} showLabel className="text-xs text-muted-foreground" />
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
        {items.length > 5 && (
          <button type="button" className="justify-self-start text-sm font-medium text-primary hover:underline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${items.length}`}
          </button>
        )}
      </Section>
    </>
  );
}
