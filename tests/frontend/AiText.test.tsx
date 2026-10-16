import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AiText } from "@/components/AiText";

describe("AiText", () => {
  it("labels AI text and reveals exactly what the AI saw, with placeholders as chips", async () => {
    render(<AiText text="Acme charged 18% more this month." redactedInput="Pay [SUPPLIER_1] into [BANK_ACCOUNT_1] by Friday" />);
    expect(screen.getByText("Checked against your records")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "What the AI saw" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const saw = screen.getByTestId("ai-saw");
    expect(saw).toHaveTextContent("Pay [SUPPLIER_1] into [BANK_ACCOUNT_1] by Friday");
    const chips = saw.querySelectorAll("[data-placeholder]");
    expect(Array.from(chips, (c) => c.textContent)).toEqual(["[SUPPLIER_1]", "[BANK_ACCOUNT_1]"]);
  });

  it("renders AI output as plain text, never HTML", () => {
    const { container } = render(<AiText text={'<img src=x onerror="alert(1)"><b>bold</b>'} redactedInput="" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeInTheDocument();
  });
});
