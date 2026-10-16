import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Money } from "@/components/Money";
import { formatMoney } from "@/lib/money";
import { PrivacyProvider, usePrivacy } from "@/lib/privacy";

function Toggle() {
  const { toggle } = usePrivacy();
  return (
    <button type="button" onClick={toggle}>
      toggle
    </button>
  );
}

describe("Money", () => {
  it("formats minor units as pounds with thousands separators", () => {
    const { container } = render(<Money minor={123456} />);
    expect(container).toHaveTextContent("£1,234.56");
  });

  it("shows pence slightly smaller than pounds", () => {
    const { container } = render(<Money minor={123456} />);
    const pence = container.querySelector("span > span");
    expect(pence).toHaveTextContent(".56");
    expect(pence).toHaveClass("text-[0.8em]");
    expect(pence?.parentElement?.firstChild?.textContent).toBe("£");
  });

  it("keeps exact pence for single-digit and zero amounts", () => {
    expect(render(<Money minor={5} />).container).toHaveTextContent("£0.05");
    expect(render(<Money minor={0} />).container).toHaveTextContent("£0.00");
    expect(render(<Money minor={100000000} />).container).toHaveTextContent("£1,000,000.00");
  });

  it("shows a minus sign for negative amounts", () => {
    expect(render(<Money minor={-4200} />).container).toHaveTextContent("−£42.00");
  });

  it("marks money in as green with a plus, and keeps money out neutral", () => {
    const moneyIn = render(<Money minor={1500} direction="in" />).container.firstElementChild!;
    expect(moneyIn).toHaveTextContent("+£15.00");
    expect(moneyIn).toHaveClass("text-money-in");

    const moneyOut = render(<Money minor={1500} direction="out" />).container.firstElementChild!;
    expect(moneyOut).toHaveTextContent("−£15.00");
    expect(moneyOut).not.toHaveClass("text-money-in");
  });

  it("uses the business currency", () => {
    expect(render(<Money minor={99900} currency="EUR" />).container).toHaveTextContent("€999.00");
  });

  it("hides every amount in privacy mode", () => {
    render(
      <PrivacyProvider initialHidden>
        <Money minor={123456} />
      </PrivacyProvider>,
    );
    const hidden = screen.getByLabelText("Amount hidden");
    expect(hidden).toHaveTextContent("£••••");
    expect(document.body).not.toHaveTextContent("1,234");
  });

  it("toggles privacy mode and remembers it", async () => {
    render(
      <PrivacyProvider>
        <Money minor={2500} />
        <Toggle />
      </PrivacyProvider>,
    );
    expect(document.body).toHaveTextContent("£25.00");
    await act(() => userEvent.click(screen.getByRole("button", { name: "toggle" })));
    expect(document.body).toHaveTextContent("£••••");
    expect(window.localStorage.getItem("copilot.privacy")).toBe("1");
  });

  it("still works when storage is blocked", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      render(
        <PrivacyProvider>
          <Money minor={2500} />
        </PrivacyProvider>,
      );
      expect(document.body).toHaveTextContent("£25.00");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("formats plain text for sentences", () => {
    expect(formatMoney(124000)).toBe("£1,240.00");
    expect(formatMoney(124000, "GBP", true)).toBe("£••••");
  });
});
