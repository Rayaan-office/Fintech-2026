/** Every API error carries a message written for the user (`{detail}`), which we show as-is. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export const NETWORK_ERROR = "We couldn't reach the server. Check your connection and try again.";
export const TWO_STEP_REQUIRED = "Two-step sign-in required.";

const FALLBACK: Record<number, string> = {
  401: "Please sign in.",
  403: "Your role does not allow this.",
  404: "We couldn't find that.",
  413: "That file is too large.",
  429: "Too many requests. Please wait a moment and try again.",
};

async function readDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") return body.detail;
  } catch {
    // Not JSON
  }
  return FALLBACK[res.status] ?? "Something went wrong on our side. Please try again in a moment.";
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

/**
 * Same-origin JSON request. The session lives in an HttpOnly cookie, so there is no token to
 * attach; the browser adds the Origin header the server checks on every change.
 */
export async function api<T>(path: string, { method = "GET", body, signal }: RequestOptions = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}) },
    signal,
  };
  if (body !== undefined) init.body = isForm ? body : JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (!res.ok) throw new ApiError(res.status, await readDetail(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** For screens whose endpoint may not exist yet: a 404 means "nothing to show". */
export async function apiOptional<T>(path: string, options?: RequestOptions): Promise<T | null> {
  try {
    return await api<T>(path, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail;
  return "Something went wrong on our side. Please try again in a moment.";
}
