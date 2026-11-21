// Contract every issue provider implements, and the HTTP helper they share.
// Provider modules only translate between their REST API and `ExternalIssue`; everything else is generic.

import type { ExternalIssue, IssueSource } from "../../shared/issues.ts";

export interface IssueProvider {
  /** Every open issue of the repository (all pages), pull requests excluded. */
  listOpenIssues(src: IssueSource, token?: string): Promise<ExternalIssue[]>;
  /** One issue by number; null when it does not exist (404/410). */
  getIssue(src: IssueSource, token: string | undefined, number: number): Promise<ExternalIssue | null>;
  comment(src: IssueSource, token: string, number: number, text: string): Promise<void>;
  close(src: IssueSource, token: string, number: number): Promise<void>;
}

export type ProviderErrorKind = "auth" | "notFound" | "rateLimit" | "network" | "other";

/** Error of a provider call. Its message never contains the token nor request headers. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike | null = null;

/** Replaces the HTTP client in tests; `null` restores the global fetch. */
export function setFetchForTests(f: FetchLike | null) {
  fetchImpl = f;
}

const TIMEOUT_MS = 15_000;

export interface RequestOptions {
  method?: string;
  token?: string;
  /** Builds the Authorization header value from the token (each provider has its scheme). */
  authHeader?: (token: string) => string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

/** Strips anything that looks like a secret from a provider message and caps its length. */
function cleanMessage(msg: string, token?: string): string {
  let m = msg.replace(/\s+/g, " ").trim();
  if (token) m = m.split(token).join("***");
  return m.slice(0, 200);
}

async function providerMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { message?: unknown };
      if (typeof j.message === "string") return j.message;
    } catch {}
    return text;
  } catch {
    return "";
  }
}

/** Sends a JSON request and maps every failure to a ProviderError. 204 resolves with `data: null`. */
export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.token && opts.authHeader) headers.Authorization = opts.authHeader(opts.token);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const f: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  let res: Response;
  try {
    res = await f(url, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError("network", `network error: ${cleanMessage(msg, opts.token)}`);
  }
  if (res.ok) {
    if (res.status === 204) return { data: null as T, headers: res.headers };
    try {
      const text = await res.text();
      return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
    } catch {
      throw new ProviderError("other", "invalid response from the provider", res.status);
    }
  }
  const msg = cleanMessage(await providerMessage(res), opts.token);
  const rateLimited =
    res.status === 429 || ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0");
  if (rateLimited) throw new ProviderError("rateLimit", "rate limit exceeded", res.status);
  if (res.status === 401) throw new ProviderError("auth", "invalid token", res.status);
  if (res.status === 403) {
    if (/bad credentials|invalid token|token is invalid|unauthori[sz]ed/i.test(msg)) throw new ProviderError("auth", "invalid token", 403);
    throw new ProviderError("auth", `forbidden${msg ? `: ${msg}` : ""}`, 403);
  }
  if (res.status === 404 || res.status === 410)
    throw new ProviderError("notFound", "not found (check the repository and the token)", res.status);
  throw new ProviderError("other", `HTTP ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
}

/** Calls `requestJson` and returns null on notFound, for single-resource reads. */
export async function requestOrNull<T>(url: string, opts: RequestOptions): Promise<T | null> {
  try {
    return (await requestJson<T>(url, opts)).data;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "notFound") return null;
    throw e;
  }
}

/** Repo path segment `owner/name`, each part URL-encoded. */
export function repoPath(repo: string): string {
  return repo
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}
