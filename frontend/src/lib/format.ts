const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const relFmt = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "2026-10-18" is a calendar day, not a moment: `new Date()` would read it as midnight UTC,
 * which is the evening before anywhere west of London. Read it as that day where the person is.
 */
export function parseDay(iso: string): Date {
  const m = DATE_ONLY.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

/** Today (or `at`) as an ISO day where the person is, not in UTC. */
export function localDay(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A calendar day `n` days after an ISO day, as an ISO day. Counted in whole days, so clock changes don't matter. */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return t.toISOString().slice(0, 10);
}

/** Whole days from one ISO day to another. */
export function daysBetween(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function formatDate(iso: string, withYear = false): string {
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (withYear ? dateYearFmt : dateFmt).format(d);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dateYearFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** "2 minutes ago", "yesterday", "in 3 days". */
export function formatRelative(iso: string, now = Date.now()): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const seconds = Math.round((d - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relFmt.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relFmt.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return relFmt.format(Math.round(seconds / 86400), "day");
  return formatDate(iso, true);
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
