import { CameraIcon, Loader2Icon, UploadIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

// The server's limit
export const MAX_MB = 15;

export type UploadPicker = {
  /** The hidden file inputs; render once on the page. */
  inputs: ReactNode;
  /** Opens the file picker. */
  pick: () => void;
  /** Opens the camera (phones). */
  photo: () => void;
  /** Takes dropped or picked files: too-big ones are refused here, the rest go on. */
  take: (list: FileList | File[] | null, fromCamera?: boolean) => void;
  error: string | null;
};

/**
 * One set of file inputs for a page, so an Upload button, a drop zone and a whole-page drop all
 * send files the same way. Files are checked again on the server.
 */
export function useUploadPicker({ onFiles, accept, camera = false }: { onFiles: (files: File[], fromCamera: boolean) => void; accept: string; camera?: boolean }): UploadPicker {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const take = (list: FileList | File[] | null, fromCamera = false) => {
    const files = Array.from(list ?? []);
    const tooBig = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
    setError(tooBig.length ? `${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} larger than ${MAX_MB} MB. Try a smaller scan or photo.` : null);
    const ok = files.filter((f) => f.size <= MAX_MB * 1024 * 1024);
    if (ok.length) onFiles(ok, fromCamera);
  };

  const inputs = (
    <>
      <input ref={fileRef} type="file" data-testid="file-input" accept={accept} multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      {camera && <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files, true); e.target.value = ""; }} />}
    </>
  );
  return { inputs, pick: () => fileRef.current?.click(), photo: () => cameraRef.current?.click(), take, error };
}

/** Why a file was refused, said once under the upload controls. */
export function UploadError({ error, className }: { error: string | null; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn("text-sm text-danger", className)}>
      {error}
    </p>
  );
}

/** Drop files, pick them, or (on a phone) take a photo. */
export function UploadDropzone({
  picker,
  pending,
  hint,
  camera = false,
  onClose,
  className,
}: {
  picker: UploadPicker;
  pending: boolean;
  hint: string;
  camera?: boolean;
  /** Shows a close button, for a drop zone opened on request. */
  onClose?: () => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        // Marked as handled, so a whole-page drop target leaves these files alone
        e.preventDefault();
        setDragging(false);
        picker.take(e.dataTransfer.files);
      }}
      className={cn(
        "relative flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center transition-colors",
        dragging && "border-primary bg-primary-soft/50",
        className,
      )}
    >
      {onClose && (
        <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" onClick={onClose} aria-label="Close the drop zone">
          <XIcon aria-hidden />
        </Button>
      )}
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        {pending ? <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden /> : <UploadIcon className="size-5 text-muted-foreground" aria-hidden />}
      </span>
      <p className="text-sm font-medium">{pending ? "Uploading…" : "Drop files here"}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" size="sm" onClick={picker.pick} disabled={pending}>
          Choose files
        </Button>
        {camera && (
          <Button variant="secondary" size="sm" onClick={picker.photo} disabled={pending} className="sm:hidden">
            <CameraIcon aria-hidden /> Take a photo
          </Button>
        )}
      </div>
      <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Files dragged anywhere over the page: a full-page drop target appears while they are held, and
 * dropping them there uploads them. Dropping elsewhere never opens the file in the browser.
 */
export function PageDrop({ onDrop, label = "Drop to upload" }: { onDrop: (files: FileList) => void; label?: string }) {
  const [dragging, setDragging] = useState(false);
  const reduce = useReducedMotion();
  const depth = useRef(0);
  const handler = useRef(onDrop);
  handler.current = onDrop;

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = 0;
      setDragging(false);
      // A drop zone on the page already took them
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer?.files.length) handler.current(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-6 backdrop-blur-[2px]"
          aria-hidden
        >
          <div className="flex h-full max-h-96 w-full max-w-xl flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card/90 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary-soft">
              <UploadIcon className="size-6 text-primary" />
            </span>
            <p className="text-base font-medium">{label}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
