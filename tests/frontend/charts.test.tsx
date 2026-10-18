import { render } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CashAreaChart } from "@/components/charts";
import { forecastSeries } from "./fixtures";

// jsdom has no layout, so give the chart a fixed size instead of measuring its box
vi.mock("recharts", async (load) => {
  const recharts = await load<typeof import("recharts")>();
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => (
      <div style={{ width: 800, height: 300 }}>{cloneElement(children, { width: 800, height: 300 })}</div>
    ),
  };
});

describe("Cash chart", () => {
  it("keeps the safety level in view when cash stays below it the whole time", () => {
    // Regression: the axis only reached the highest forecast day, so a safety level above every day dropped out of the chart
    const { container } = render(<CashAreaChart series={forecastSeries()} safetyLevelMinor={5_000_000} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain("Safety level");
  });
});
