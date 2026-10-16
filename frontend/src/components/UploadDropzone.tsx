import { CameraIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const MAX_MB = 20;

/** Drop files, pick them, or (on a phone) take a photo. Files are checked again on the server. */
export function UploadDropzone({
  onFiles,
  pending,
  accept,
  hint,
  camera = false,
  className,
}: {
  onFiles: (files: File[]) => void;
  pending: boolean;
  accept: string;
  hint: string;
  camera?: boolean;
  className?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    const tooBig = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
    setError(tooBig.length ? `${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} larger than ${MAX_MB} MB. Try a smaller scan or photo.` : null);
    const ok = files.filter((f) => f.size <= MAX_MB * 1024 * 1024);
    if (ok.length) onFiles(ok);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take(e.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-8 text-center transition-colors",
        dragging && "border-primary bg-primary-soft/50",
        className,
      )}
    >
      {pending ? <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden /> : <UploadIcon className="size-5 text-muted-foreground" aria-hidden />}
      <p className="text-sm">
        {pending ? "Uploading…" : "Drop files here, or"}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={pending}>
          Choose files
        </Button>
        {camera && (
          <Button variant="secondary" onClick={() => cameraRef.current?.click()} disabled={pending} className="sm:hidden">
            <CameraIcon aria-hidden /> Take a photo
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <input ref={fileRef} type="file" accept={accept} multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      {camera && <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files); e.target.value = ""; }} />}
    </div>
  );
}
