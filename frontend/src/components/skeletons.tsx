import { Skeleton } from "./ui/skeleton";

/** Loading shows the shape of the page, never a blank screen. Flat, like the pages: few boxes. */

export function HeadlineSkeleton() {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-9 w-48" />
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <Skeleton className="mb-4 h-4 w-32" />
      <Skeleton className="w-full rounded-lg" style={{ height }} />
    </div>
  );
}

/** A row of numbers divided by hairlines, as a StatStrip reads once loaded. */
export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-y-5 sm:flex sm:divide-x">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="min-w-0 sm:flex-1 sm:px-6 sm:first:pl-0 sm:last:pr-0">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-2.5 h-6 w-32" />
          <Skeleton className="mt-2 h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y rounded-xl border bg-card">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-3.5" style={{ width: `${60 - (i % 3) * 12}%` }} />
            <Skeleton className="mt-2 h-3 w-1/4" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="grid gap-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-40" />
      <CardsSkeleton />
      <ChartSkeleton />
    </div>
  );
}
