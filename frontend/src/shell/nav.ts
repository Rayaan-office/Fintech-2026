import {
  ActivityIcon,
  BrainCircuitIcon,
  ChartColumnIcon,
  FileTextIcon,
  HouseIcon,
  InboxIcon,
  LandmarkIcon,
  LightbulbIcon,
  MessageCircleIcon,
  PlugIcon,
  ReceiptIcon,
  SettingsIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import type { Me, Permission } from "@/api/types";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the user has this permission. */
  perm: Permission | null;
  place: "main" | "bottom" | "hidden";
  /** In the phone bottom bar (the rest live in the "More" drawer). */
  phone?: boolean;
  /** Only for people who can't see the full books (e.g. employees). */
  onlyWithout?: Permission;
};

export const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: HouseIcon, perm: "view_all", place: "main", phone: true },
  { to: "/inbox", label: "Inbox", icon: InboxIcon, perm: "view_all", place: "main", phone: true },
  { to: "/ask", label: "Ask", icon: MessageCircleIcon, perm: "use_assistant", place: "main", phone: true },
  { to: "/cash-flow", label: "Cash flow", icon: TrendingUpIcon, perm: "view_all", place: "main", phone: true },
  { to: "/health", label: "Business health", icon: ChartColumnIcon, perm: "view_all", place: "main" },
  { to: "/recommendations", label: "Recommendations", icon: LightbulbIcon, perm: "view_all", place: "hidden" },
  { to: "/financing", label: "Financing", icon: LandmarkIcon, perm: "use_financing", place: "main" },
  { to: "/documents", label: "Documents", icon: FileTextIcon, perm: "view_all", place: "main" },
  { to: "/activity", label: "Activity", icon: ActivityIcon, perm: "view_activity", place: "main" },
  { to: "/my-receipts", label: "My receipts", icon: ReceiptIcon, perm: "submit_receipt", place: "main", phone: true, onlyWithout: "view_all" },
  { to: "/learning", label: "What we've learned", icon: BrainCircuitIcon, perm: "view_all", place: "bottom" },
  { to: "/connections", label: "Connections", icon: PlugIcon, perm: "view_all", place: "bottom" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, perm: null, place: "bottom", phone: true },
];

export function canSee(item: NavItem, me: Me): boolean {
  if (item.perm && !me.permissions.includes(item.perm)) return false;
  if (item.onlyWithout && me.permissions.includes(item.onlyWithout)) return false;
  return true;
}

export function visibleNav(me: Me): NavItem[] {
  return NAV.filter((i) => canSee(i, me));
}

/** Where to land after signing in. */
export function startPath(me: Me): string {
  if (me.permissions.includes("view_all")) return "/";
  if (me.permissions.includes("submit_receipt")) return "/my-receipts";
  return "/settings";
}
