import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhoneHandoff } from "@/components/PhoneHandoff";
import { mockApi, renderApp, renderWithProviders } from "./utils";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv.secret-part-of-the-link-that-is-long-enough-123";
const inTen = () => new Date(Date.now() + 10 * 60_000).toISOString();

describe("Phone upload page", () => {
  it("opens without signing in and sends a photo to the business", async () => {
    let left = 10;
    const { fetchMock, calls } = mockApi({
      [`GET /api/handoff/upload/${TOKEN}`]: () => ({ status: 200, body: { business: "Demo Business Ltd", expires_at: inTen(), left } }),
      [`POST /api/handoff/upload/${TOKEN}`]: () => ({ status: 200, body: { id: "d1", left: --left } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(`/m/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "Demo Business Ltd" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/auth/me")).toBe(false); // no sign-in
    expect(screen.getByText(/Personal and bank details are hidden/)).toBeInTheDocument();

    const camera = document.querySelector<HTMLInputElement>('input[capture="environment"]')!;
    expect(camera).toHaveAttribute("accept", "image/*");
    fireEvent.change(camera, { target: { files: [new File(["jpeg"], "receipt.jpg", { type: "image/jpeg" })] } });
    const sent = await screen.findByRole("list", { name: "Sent" });
    expect(within(sent).getByText("receipt.jpg")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect((post.init?.body as FormData).get("file")).toBeInstanceOf(File);
    expect(screen.getByText(/9 more photos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Take another photo/ })).toBeEnabled();
  });

  it("says plainly when the link has expired", async () => {
    const { fetchMock } = mockApi({
      [`GET /api/handoff/upload/${TOKEN}`]: () => ({ status: 404, body: { detail: "This link has expired or been used up. Scan a new code on your computer." } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(`/m/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "Scan a new code" })).toBeInTheDocument();
    expect(screen.getByText(/Scan a new code on your computer/)).toBeInTheDocument();
  });
});

describe("Use your phone", () => {
  // Bug: the button asked for an endpoint that didn't exist, so the dialog only ever showed an error
  it("shows the code, says the phone needs the same Wi-Fi on a local address, and lists photos as they arrive", async () => {
    let arrived: { id: string; filename: string; status: string }[] = [];
    const { fetchMock, calls } = mockApi({
      "POST /api/handoff": () => ({ status: 200, body: { id: "h1", url: `http://192.168.1.20:5173/m/${TOKEN}`, expires_at: inTen(), max_uploads: 10 } }),
      "GET /api/handoff/h1": () => ({ status: 200, body: { id: "h1", expires_at: inTen(), expired: false, received: arrived } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<PhoneHandoff />);
    await userEvent.click(screen.getByRole("button", { name: "Use your phone" }));
    const dialog = await screen.findByRole("dialog", { name: "Use your phone" });
    expect(await within(dialog).findByTitle("QR code to open the upload page on your phone")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Use the same Wi-Fi as this computer.");
    expect(dialog).toHaveTextContent("up to 10 photos");

    arrived = [{ id: "d1", filename: "receipt.jpg", status: "queued" }];
    const list = await within(dialog).findByRole("list", { name: "Arrived from your phone" }, { timeout: 4000 });
    expect(list).toHaveTextContent("receipt.jpg");
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/handoff/h1").length).toBeGreaterThan(1));
  });
});
