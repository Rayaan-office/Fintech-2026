import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";
import type { Permission } from "@/api/types";
import { LoginPage } from "./pages/auth/LoginPage";
import { TwoStepPage } from "./pages/auth/TwoStepPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { AppShell } from "./shell/AppShell";
import { RequireAuth, RequirePerm, ShellSkeleton } from "./shell/guards";

// Pages load on demand so the sign-in screen stays small
function page(path: string | undefined, perm: Permission | null, load: () => Promise<{ default: ComponentType }>): RouteObject {
  const lazy = async () => {
      const { default: Page } = await load();
      return {
        Component: () => (
          <RequirePerm perm={perm}>
            <Page />
          </RequirePerm>
        ),
      };
  };
  return path === undefined ? { index: true, lazy } : { path, lazy };
}

export const routes: RouteObject[] = [
  {
    HydrateFallback: ShellSkeleton,
    children: [
      { path: "/sign-in", Component: LoginPage },
      { path: "/sign-in/two-step", Component: TwoStepPage },
      // Opened on a phone from the QR code: the link is the key, so no sign-in
      { path: "/m/:token", lazy: async () => ({ Component: (await import("./pages/PhoneUploadPage")).default }) },
      {
        Component: RequireAuth,
        children: [
          {
            Component: AppShell,
            children: [
              page(undefined, "view_all", () => import("./pages/HomePage")),
              page("inbox", "view_all", () => import("./pages/InboxPage")),
              page("ask", "use_assistant", () => import("./pages/AskPage")),
              page("cash-flow", "view_all", () => import("./pages/CashFlowPage")),
              page("health", "view_all", () => import("./pages/HealthPage")),
              page("recommendations", "view_all", () => import("./pages/RecommendationsPage")),
              page("financing", "use_financing", () => import("./pages/FinancingPage")),
              page("documents", "view_all", () => import("./pages/DocumentsPage")),
              page("activity", "view_activity", () => import("./pages/ActivityPage")),
              page("connections", "view_all", () => import("./pages/ConnectionsPage")),
              page("learning", "view_all", () => import("./pages/LearningPage")),
              page("settings", null, () => import("./pages/SettingsPage")),
              page("my-receipts", "submit_receipt", () => import("./pages/MyReceiptsPage")),
              { path: "*", Component: NotFoundPage },
            ],
          },
        ],
      },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
