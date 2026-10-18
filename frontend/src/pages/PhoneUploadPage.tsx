import { CameraIcon, CheckCircle2Icon, FileUpIcon, Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { useParams } from "react-router";
import { errorMessage } from "@/api/client";
import { useHandoffPage, usePhoneUpload } from "@/api/hooks";
import { Logo } from "@/components/brand";
import { FormError } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";

/**
 * Opened from the QR code on a phone. No sign-in: the link is the key, works for a few photos and
 * expires in minutes. Each photo goes to the business, through the same checks as any upload.
 */
export default function PhoneUploadPage() {
  const { token = "" } = useParams();
  const page = useHandoffPage(token);
  const upload = usePhoneUpload(token);
  const [sent, setSent] = useState<string[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    upload.mutate(file, {
      onSuccess: (r) => {
        setSent((s) => [...s, file.name || "Photo"]);
        setLeft(r.left);
      },
    });
  };

  const remaining = left ?? page.data?.left ?? 0;
  const done = page.data && remaining === 0;

  return (
    <div className="flex min-h-dvh flex-col bg-sidebar px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
      <Logo markClassName="size-7" />
      <main className="mx-auto mt-10 flex w-full max-w-sm flex-1 flex-col">
        {page.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        ) : page.isError ? (
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Scan a new code</h1>
            <p className="text-sm text-muted-foreground">{errorMessage(page.error)}</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Sending to</p>
            <h1 className="text-2xl font-semibold tracking-tight">{page.data.business}</h1>

            <div className="mt-8 grid gap-3">
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPick} tabIndex={-1} aria-hidden />
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onPick} tabIndex={-1} aria-hidden />
              <Button size="lg" className="h-14 text-base" onClick={() => cameraRef.current?.click()} disabled={upload.isPending || Boolean(done)}>
                {upload.isPending ? <Loader2Icon className="animate-spin" aria-hidden /> : <CameraIcon aria-hidden />}
                {upload.isPending ? "Sending…" : sent.length ? "Take another photo" : "Take a photo"}
              </Button>
              <Button size="lg" variant="secondary" className="h-12" onClick={() => fileRef.current?.click()} disabled={upload.isPending || Boolean(done)}>
                <FileUpIcon aria-hidden /> Choose a file
              </Button>
              {upload.isError && <FormError message={errorMessage(upload.error)} />}
            </div>

            {sent.length > 0 && (
              <ul aria-label="Sent" aria-live="polite" className="mt-6 grid gap-2">
                {sent.map((name, i) => (
                  <li key={`${name}-${i}`} className="flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 text-sm">
                    <CheckCircle2Icon className="size-4 shrink-0 text-positive" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">Sent</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-auto grid gap-2 pt-10 text-xs text-muted-foreground">
              <p className="flex items-start gap-1.5">
                <ShieldCheckIcon className="mt-px size-3.5 shrink-0 text-positive" aria-hidden />
                Personal and bank details are hidden before the AI reads anything.
              </p>
              <p>{done ? "This link is used up. Scan a new code to send more." : `${remaining} more ${remaining === 1 ? "photo" : "photos"}, link expires ${formatRelative(page.data.expires_at)}.`}</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
