import type { Role } from "@/api/types";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Business owner",
  finance_manager: "Finance manager",
  bookkeeper: "Bookkeeper",
  employee: "Employee",
};

export function rolesText(roles: Role[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
}
