import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationCard, type ConfirmationCardProps } from "@/components/ConfirmationCard";

function setup(overrides: Partial<ConfirmationCardProps> = {}) {
  const props: ConfirmationCardProps = {
    title: "Change bank details for Acme Supplies",
    level: 4,
    effects: ["Future payments to Acme Supplies go to the new account", "The old account is kept in the history"],
    records: [{ id: "s1", kind: "supplier", label: "Acme Supplies", href: "/suppliers/s1" }],
    whoMustApprove: "Two people: business owner or finance manager",
    approvals: [],
    onApprove: vi.fn(),
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  };
  render(
    <MemoryRouter>
      <ConfirmationCard {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("ConfirmationCard", () => {
  it("says what will change, the records affected, the level and who must approve", () => {
    setup();
    expect(screen.getByText("Future payments to Acme Supplies go to the new account")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acme Supplies" })).toHaveAttribute("href", "/suppliers/s1");
    expect(screen.getByLabelText("Approval level 4: Two people")).toBeInTheDocument();
    expect(screen.getByText("Two people: business owner or finance manager")).toBeInTheDocument();
  });

  it("calls Approve, Edit and Cancel", async () => {
    const props = setup({ level: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onEdit).toHaveBeenCalledOnce();
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("disables Approve and always says why", async () => {
    const props = setup({ approveDisabledReason: "Your role can't approve this. A business owner must approve it." });
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription("Your role can't approve this. A business owner must approve it.");
    expect(screen.getByText(/Your role can't approve this/)).toBeVisible();
    await userEvent.click(approve);
    expect(props.onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("explains a disabled Edit button too", () => {
    setup({ editDisabledReason: "Bank details can only be changed by the supplier." });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAccessibleDescription("Bank details can only be changed by the supplier.");
  });

  it("shows two-person progress and the first approver", () => {
    setup({ approvals: [{ user_id: "u1", name: "Priya Shah", at: new Date().toISOString() }], currentUserId: "u2" });
    expect(screen.getByText("1 of 2 approvals")).toBeInTheDocument();
    expect(screen.getByText(/First approval by Priya Shah/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("stops the same person approving twice", () => {
    setup({ approvals: [{ user_id: "u1", name: "Priya Shah", at: new Date().toISOString() }], currentUserId: "u1" });
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/A different person must give the second approval/);
  });

  it("does not show progress for single-person actions", () => {
    setup({ level: 3 });
    expect(screen.queryByText(/of 2 approvals/)).not.toBeInTheDocument();
  });
});
