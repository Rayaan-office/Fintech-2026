import { cn } from "@/lib/utils";

export const PRODUCT = "Cocent";
export const TAGLINE = "Every cent, with your consent.";

/** The Cocent "C" mark. Decorative: the product name always sits beside it or in a label. */
export function CocentMark({ className }: { className?: string }) {
  return <img src="/cocent-mark.png" alt="" aria-hidden width={28} height={28} className={cn("size-7 shrink-0 select-none", className)} draggable={false} />;
}

/** Mark plus wordmark. */
export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <CocentMark className={markClassName} />
      <span className="text-[17px] font-semibold tracking-tight">{PRODUCT}</span>
    </span>
  );
}
