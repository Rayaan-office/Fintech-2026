import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, Loader2Icon, SmartphoneIcon, WifiIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/api/client";
import { useCreateHandoff, useHandoffStatus } from "@/api/hooks";
import { formatRelative } from "@/lib/format";
import { FormError } from "./states";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** A link on a local network address, as in development: the phone needs to be on the same Wi-Fi. */
const onLocalNetwork = (url: string) => /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//.test(url);

/** Scan on the computer, photograph a receipt on the phone, watch it arrive here. */
export function PhoneHandoff({ variant = "secondary", className }: { variant?: "secondary" | "default"; className?: string }) {
  const [open, setOpen] = useState(false);
  const handoff = useCreateHandoff();
  const status = useHandoffStatus(open ? (handoff.data?.id ?? null) : null);
  const qc = useQueryClient();
  const received = status.data?.received ?? [];
  const seen = useRef(0);

  // Each photo that arrives shows up in the documents list straight away
  useEffect(() => {
    if (received.length > seen.current) void qc.invalidateQueries({ queryKey: ["documents"] });
    seen.current = received.length;
  }, [received.length, qc]);

  const start = () => {
    setOpen(true);
    seen.current = 0;
    handoff.mutate();
  };
  const data = handoff.data;
  const expired = status.data?.expired;

  return (
    <>
      <Button variant={variant} onClick={start} className={className}>
        <SmartphoneIcon aria-hidden /> Use your phone
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Use your phone</DialogTitle>
            <DialogDescription>Scan with your phone's camera, then take a photo. It arrives here in seconds.</DialogDescription>
          </DialogHeader>
          {handoff.isPending ? (
            <div className="flex h-56 items-center justify-center">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-label="Creating a link" />
            </div>
          ) : handoff.isError ? (
            <FormError message={errorMessage(handoff.error)} />
          ) : data ? (
            <div className="grid justify-items-center gap-4">
              {expired ? (
                <div className="grid h-56 w-full place-items-center rounded-xl border border-dashed text-center">
                  <div className="grid justify-items-center gap-3">
                    <p className="text-sm text-muted-foreground">This code has expired.</p>
                    <Button size="sm" variant="secondary" onClick={start}>
                      New code
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border bg-white p-4">
                  <QRCodeSVG value={data.url} size={192} marginSize={0} title="QR code to open the upload page on your phone" />
                </div>
              )}
              {received.length > 0 && (
                <ul aria-label="Arrived from your phone" aria-live="polite" className="grid w-full gap-1.5">
                  {received.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 rounded-lg bg-positive-soft/60 px-3 py-2 text-sm">
                      <CheckCircle2Icon className="size-4 shrink-0 text-positive" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{d.filename}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">Arrived</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid justify-items-center gap-1 text-center text-xs text-muted-foreground">
                {!expired && <p>Works for up to {data.max_uploads} photos and expires {formatRelative(data.expires_at)}.</p>}
                {onLocalNetwork(data.url) && (
                  <p className="inline-flex items-center gap-1">
                    <WifiIcon className="size-3.5 shrink-0" aria-hidden /> Use the same Wi-Fi as this computer.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
