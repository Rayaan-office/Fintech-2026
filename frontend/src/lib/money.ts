export type MoneyParts = {
  sign: "" | "+" | "−";
  symbol: string;
  whole: string;
  decimal: string;
  fraction: string;
};

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol" });
    formatters.set(currency, f);
  }
  return f;
}

export function fractionDigits(currency: string): number {
  return formatter(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

export function currencySymbol(currency: string): string {
  return formatter(currency).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
}

/** Minor units (pence) to display parts. Amounts are integers so there is no float drift. */
export function moneyParts(minor: number, currency = "GBP", sign: MoneyParts["sign"] = minor < 0 ? "−" : ""): MoneyParts {
  const digits = fractionDigits(currency);
  const major = Math.abs(minor) / 10 ** digits;
  const parts = formatter(currency).formatToParts(major);
  let symbol = "";
  let whole = "";
  let decimal = "";
  let fraction = "";
  for (const p of parts) {
    if (p.type === "currency") symbol = p.value;
    else if (p.type === "integer" || p.type === "group") whole += p.value;
    else if (p.type === "decimal") decimal = p.value;
    else if (p.type === "fraction") fraction = p.value;
  }
  return { sign, symbol, whole, decimal, fraction };
}

/** Plain-text amount for sentences, toasts and aria labels, e.g. "£1,240.00". */
export function formatMoney(minor: number, currency = "GBP", hidden = false): string {
  if (hidden) return `${currencySymbol(currency)}••••`;
  const p = moneyParts(minor, currency);
  return `${p.sign}${p.symbol}${p.whole}${p.decimal}${p.fraction}`;
}

/** Short axis label such as "£12k". */
export function formatMoneyCompact(minor: number, currency = "GBP"): string {
  const major = minor / 10 ** fractionDigits(currency);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(major);
}
