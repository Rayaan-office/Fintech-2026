import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "@/api/types";
import { mockApi, renderApp } from "./utils";

const bookkeeper: Me = {
  user: { id: "u-books", name: "Sam Taylor", email: "books@example.test", roles: ["bookkeeper"] },
  business: { id: "b1", name: "Demo Bakery", currency: "GBP", country: "GB", ai_paused: false },
  permissions: [
    "approve_match",
    "prepare_payment",
    "reconcile",
    "record_bill",
    "review_documents",
    "send_reminder",
    "submit_receipt",
    "use_assistant",
    "view_activity",
    "view_all",
    "view_own_submissions",
  ],
  approval_limit_minor: null,
  levels: { "0": "Read", "1": "Suggest", "2": "Small change", "3": "Outside action", "4": "Two people" },
  unread_notifications: 0,
};

const employee: Me = {
  ...bookkeeper,
  user: { id: "u-emp", name: "Alex Kim", email: "alex@example.test", roles: ["employee"] },
  permissions: ["submit_receipt", "view_own_submissions"],
};

async function signIn(email = "books@example.test", password = "correct horse") {
  await userEvent.type(await screen.findByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in flow", () => {
  it("sends people who aren't signed in to the sign-in screen", async () => {
    const { fetchMock } = mockApi({ "GET /api/auth/me": () => ({ status: 401, body: { detail: "Please sign in." } }) });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/cash-flow");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("shows the server's message when the password is wrong", async () => {
    const { fetchMock, calls } = mockApi({
      "GET /api/auth/me": () => ({ status: 401, body: { detail: "Please sign in." } }),
      "POST /api/auth/login": () => ({ status: 401, body: { detail: "Email or password is incorrect." } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/sign-in");
    await signIn("books@example.test", "wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    const login = calls.find((c) => c.path === "/api/auth/login")!;
    expect(login.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(login.init?.body))).toEqual({ email: "books@example.test", password: "wrong" });
  });

  it("explains rate limiting in plain words", async () => {
    const { fetchMock } = mockApi({
      "POST /api/auth/login": () => ({ status: 429, body: { detail: "Too many requests. Please wait a moment and try again." } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/sign-in");
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Please wait a moment and try again.");
  });

  it("signs a bookkeeper straight in and shows the app shell with their menu", async () => {
    let signedIn = false;
    const { fetchMock } = mockApi({
      "GET /api/auth/me": () => (signedIn ? { status: 200, body: bookkeeper } : { status: 401, body: { detail: "Please sign in." } }),
      "POST /api/auth/login": () => {
        signedIn = true;
        return { status: 200, body: { totp_required: false, totp_setup_required: false } };
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/sign-in");
    await signIn();

    const main = await screen.findAllByRole("navigation", { name: "Main" });
    expect(router.state.location.pathname).toBe("/");
    const sidebar = main[0]!;
    for (const label of ["Home", "Inbox", "Recommendations", "Ask", "Cash flow", "Business health", "Documents", "Activity"]) {
      expect(sidebar).toHaveTextContent(label);
    }
    // Bookkeepers can't use financing tools, so it isn't in their menu
    expect(sidebar).not.toHaveTextContent("Financing");
    expect(screen.getByRole("button", { name: "Account menu for Sam Taylor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide amounts" })).toBeInTheDocument();
    // Home's data endpoint isn't there yet: the page shows its empty state, never made-up numbers
    expect(await screen.findByText("Your money picture starts here")).toBeInTheDocument();
  });

  it("asks for a two-step code when the account has it set up", async () => {
    let stage: "out" | "password" | "in" = "out";
    const { fetchMock, calls } = mockApi({
      "GET /api/auth/me": () =>
        stage === "in" ? { status: 200, body: { ...bookkeeper, user: { ...bookkeeper.user, roles: ["owner"] } } } : { status: 401, body: { detail: stage === "password" ? "Two-step sign-in required." : "Please sign in." } },
      "POST /api/auth/login": () => {
        stage = "password";
        return { status: 200, body: { totp_required: true, totp_setup_required: false } };
      },
      "POST /api/auth/totp/verify": (init) => {
        const { code } = JSON.parse(String(init?.body)) as { code: string };
        if (code !== "123456") return { status: 401, body: { detail: "That code didn't work. Check the time on your phone and try again." } };
        stage = "in";
        return { status: 200, body: { ok: true } };
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/sign-in");
    await signIn("owner@example.test");

    expect(await screen.findByRole("heading", { name: "Two-step sign-in" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work.");

    await userEvent.type(screen.getByLabelText("Code"), "123456");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(await screen.findByRole("button", { name: /Account menu/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/auth/totp/verify")).toHaveLength(2);
  });

  it("sends a half-signed-in session to the two-step screen", async () => {
    const { fetchMock } = mockApi({ "GET /api/auth/me": () => ({ status: 401, body: { detail: "Two-step sign-in required." } }) });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/inbox");
    expect(await screen.findByRole("heading", { name: "Two-step sign-in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in/two-step");
  });

  it("shows a QR code and the key once when two-step needs setting up", async () => {
    const { fetchMock, calls } = mockApi({
      "POST /api/auth/login": () => ({ status: 200, body: { totp_required: false, totp_setup_required: true } }),
      "POST /api/auth/totp/setup": () => ({ status: 200, body: { otpauth_uri: "otpauth://totp/Copilot:owner?secret=JBSWY3DPEHPK3PXP", secret: "JBSWY3DPEHPK3PXP" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/sign-in");
    await signIn("owner@example.test");

    expect(await screen.findByRole("heading", { name: "Set up two-step sign-in" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Setup key")).toHaveTextContent("JBSW Y3DP EHPK 3PXP");
    expect(screen.getByTitle("QR code for your authenticator app")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/auth/totp/setup")).toHaveLength(1);
  });

  it("shows an employee only their receipts page", async () => {
    const { fetchMock } = mockApi({ "GET /api/auth/me": () => ({ status: 200, body: employee }) });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/my-receipts"));
    const sidebar = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    expect(sidebar).toHaveTextContent("My receipts");
    for (const label of ["Home", "Inbox", "Cash flow", "Documents", "Activity"]) {
      expect(sidebar).not.toHaveTextContent(label);
    }
    expect(await screen.findByRole("heading", { name: "My receipts" })).toBeInTheDocument();
  });

  it("signs out and returns to the sign-in screen", async () => {
    let signedIn = true;
    const { fetchMock, calls } = mockApi({
      "GET /api/auth/me": () => (signedIn ? { status: 200, body: bookkeeper } : { status: 401, body: { detail: "Please sign in." } }),
      "POST /api/auth/logout": () => {
        signedIn = false;
        return { status: 200, body: { ok: true } };
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: "Account menu for Sam Taylor" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/auth/logout")).toBe(true);
  });
});
