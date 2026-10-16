import { moneyParts, currencySymbol, formatMoney } from "@/lib/money";
import { usePrivacy } from "@/lib/privacy";
import { cn } from "@/lib/utils";

export type MoneyDirection = "in" | "out" | "auto";

export type MoneyProps = {
  /** Integer minor units, e.g. pence. */
  minor: number;
  currency?: string;
  /**
   * `in` shows "+" in green, `out` shows "−" in the normal text colour (never alarming),
   * `auto` shows "−" only for negative values.
   */
  direction?: MoneyDirection;
  className?: string;
};

export function Money({ minor, currency = "GBP", direction = "auto", className }: MoneyProps) {
  const { hidden } = usePrivacy();

  if (hidden) {
    return (
      <span className={cn("tabular whitespace-nowrap", className)} aria-label="Amount hidden" data-privacy="hidden">
        {currencySymbol(currency)}••••
      </span>
    );
  }

  const sign = direction === "in" ? "+" : direction === "out" ? "−" : minor < 0 ? "−" : "";
  const parts = moneyParts(minor, currency, minor === 0 ? "" : sign);
  return (
    <span
      className={cn("tabular whitespace-nowrap", direction === "in" && minor !== 0 && "text-money-in", className)}
      title={direction === "auto" ? undefined : direction === "in" ? "Money in" : "Money out"}
    >
      {parts.sign}
      {parts.symbol}
      {parts.whole}
      {parts.fraction && (
        <span className="text-[0.8em]">
          {parts.decimal}
          {parts.fraction}
        </span>
      )}
    </span>
  );
}

/** Text version for sentences and labels, honouring privacy mode. */
export function useMoneyText() {
  const { hidden } = usePrivacy();
  return (minor: number, currency = "GBP") => formatMoney(minor, currency, hidden);
}
