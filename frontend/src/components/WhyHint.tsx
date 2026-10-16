import { useId, useState } from "react";

/** "Why am I seeing this?" on every warning and recommendation. */
export function WhyHint({ why }: { why: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="text-xs">
      <button type="button" className="font-medium text-primary hover:underline" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        Why am I seeing this?
      </button>
      {open && (
        <p id={id} className="mt-1 text-muted-foreground">
          {why}
        </p>
      )}
    </div>
  );
}
