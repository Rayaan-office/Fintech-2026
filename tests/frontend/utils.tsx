import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createQueryClient } from "@/api/queryClient";
import { Providers } from "@/App";
import { routes } from "@/router";

/** Render a component with the app's providers (query client, privacy, theme, tooltips). */
export function renderWithProviders(ui: ReactElement, { privacyHidden }: { privacyHidden?: boolean } = {}) {
  if (privacyHidden !== undefined) window.localStorage.setItem("copilot.privacy", privacyHidden ? "1" : "0");
  const client = createQueryClient();
  return render(<Providers client={client}>{ui}</Providers>);
}

/** Render the whole app at a path, as the browser would. */
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const client = createQueryClient();
  const utils = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...utils, router };
}

type Handler = (init: RequestInit | undefined) => { status: number; body?: unknown };

/** A fetch stub keyed by "METHOD /path"; anything unknown answers 404 like a missing endpoint. */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: { method: string; path: string; init: RequestInit | undefined }[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:5173");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, init });
    const handler = handlers[`${method} ${url.pathname}`];
    const { status, body } = handler ? handler(init) : { status: 404, body: { detail: "Not Found" } };
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetchMock, calls };
}
