import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalLevel } from "@/api/types";
import { ApprovalBadge } from "@/components/ApprovalBadge";

const expected: [ApprovalLevel, string][] = [
  [0, "Read"],
  [1, "Suggest"],
  [2, "Small change"],
  [3, "Outside action"],
  [4, "Two people"],
];

describe("ApprovalBadge", () => {
  it.each(expected)("level %i shows an icon and the label %s", (level, label) => {
    render(<ApprovalBadge level={level} />);
    const badge = screen.getByLabelText(`Approval level ${level}: ${label}`);
    expect(badge).toHaveTextContent(label);
    expect(badge.querySelector("svg")).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-level", String(level));
  });

  it("explains the level on hover", () => {
    render(<ApprovalBadge level={4} />);
    expect(screen.getByLabelText(/Approval level 4/)).toHaveAttribute("title", expect.stringContaining("two different people"));
  });

  it("marks only the two-person level as needing attention", () => {
    const { rerender } = render(<ApprovalBadge level={4} />);
    expect(screen.getByLabelText(/Approval level 4/)).toHaveClass("text-warning");
    rerender(<ApprovalBadge level={2} />);
    expect(screen.getByLabelText(/Approval level 2/)).not.toHaveClass("text-warning");
  });
});
