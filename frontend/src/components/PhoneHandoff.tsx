import { Loader2Icon, SmartphoneIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { errorMessage } from "@/api/client";
import { useCreateHandoff } from "@/api/hooks";
import { formatRelative } from "@/lib/format";
import { FormError } from "./states";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** Scan on the computer, photograph a receipt on the phone, watch it arrive here. */
export function PhoneHandoff({ variant = "secondary" }: { variant?: "secondary" | "default" }) {
  const [open, setOpen] = useState(false);
  const handoff = useCreateHandoff();

  const start = () => {
    setOpen(true);
    handoff.mutate();
  };

  return (
    <>
      <Button variant={variant} onClick={start}>
        <SmartphoneIcon aria-hidden /> Use your phone
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Photograph a receipt with your phone</DialogTitle>
            <DialogDescription>Scan this code with your phone's camera. Photos you take there arrive here in seconds.</DialogDescription>
          </DialogHeader>
          {handoff.isPending ? (
            <div className="flex h-56 items-center justify-center">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-label="Creating a link" />
            </div>
          ) : handoff.isError ? (
            <FormError message={errorMessage(handoff.error)} />
          ) : handoff.data ? (
            <div className="grid justify-items-center gap-3">
              <div className="rounded-xl border bg-white p-4">
                <QRCodeSVG value={handoff.data.url} size={192} marginSize={0} title="QR code to open the upload page on your phone" />
              </div>
              <p className="text-xs text-muted-foreground">This code works once and expires {formatRelative(handoff.data.expires_at)}.</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
