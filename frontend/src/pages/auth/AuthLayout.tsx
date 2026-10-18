import { Logo, TAGLINE } from "@/components/brand";
import type { ReactNode } from "react";

/** A quiet page with one centred card: the product, a heading, a line of copy and the form. */
export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10">
      <div className="mb-6 grid justify-items-center gap-1.5">
        <Logo markClassName="size-8" className="[&>span:last-child]:text-xl" />
        <p className="text-sm text-muted-foreground">{TAGLINE}</p>
      </div>
      <main className="w-full max-w-sm rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}
