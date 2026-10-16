import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return (first + last).toUpperCase();
}

// Stable soft tint per name, from a small palette of neutral-friendly hues
const hues = [272, 220, 190, 155, 85, 40, 330];
function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[h % hues.length] ?? 272;
}

export function Initials({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const hue = hueFor(name);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium",
        "bg-[oklch(0.93_0.04_var(--hue))] text-[oklch(0.38_0.1_var(--hue))] dark:bg-[oklch(0.32_0.05_var(--hue))] dark:text-[oklch(0.88_0.06_var(--hue))]",
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-10 text-sm",
        className,
      )}
      style={{ "--hue": hue } as CSSProperties}
    >
      {initialsOf(name)}
    </span>
  );
}
