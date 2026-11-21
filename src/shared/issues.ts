// Issue sources: a project's Backlog fed by the issues of an external tracker (GitHub, Gitea, ...).
// This module is client-safe: types, normalizers and the provider metadata. No network code here.
// Provider-specific behaviour lives only in src/server/issues/<provider>.ts.

/** Metadata of a provider, used by the UI and the generic server code. Never branch on `id` outside this table. */
export interface ProviderInfo {
  id: string;
  label: string;
  /** Base URL used when the user leaves the field empty; absent when the field is required. */
  defaultBaseUrl?: string;
  baseUrlRequired: boolean;
  /** Placeholder shown in the base URL field. */
  baseUrlHint: string;
  /** Git remote hosts that belong to this provider (e.g. github.com). */
  matchHosts?: string[];
  /** Base URL derived from a remote host of `matchHosts`. */
  remoteBaseUrl?: string;
  /** Provider assumed for an HTTPS remote whose host matches no `matchHosts`. At most one entry sets it. */
  fallbackForHttps?: true;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "github",
    label: "GitHub",
    defaultBaseUrl: "https://api.github.com",
    baseUrlRequired: false,
    baseUrlHint: "https://api.github.com",
    matchHosts: ["github.com"],
    remoteBaseUrl: "https://api.github.com",
  },
  {
    id: "gitea",
    label: "Gitea",
    baseUrlRequired: true,
    baseUrlHint: "https://gitea.example.com",
    fallbackForHttps: true,
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Label of a provider id, the raw id when unknown. */
export function providerLabel(id: string): string {
  return providerInfo(id)?.label ?? id;
}

/** A configured link between a board and an external issue tracker. Stored in `nightshift.json`. */
export interface IssueSource {
  id: string;
  provider: string;
  /** API root (GitHub) or instance root (Gitea), without a trailing slash. */
  baseUrl: string;
  /** `owner/name`. */
  repo: string;
  /** Only issues with at least one of these labels (case-insensitive). Absent = every open issue. */
  labels?: string[];
  enabled: boolean;
  /** External ids already imported; never shrinks, so a card deleted by hand is not imported again. */
  importedIds: string[];
}

/** Editable fields of a source, as sent by the client. `id` absent = new source. */
export interface IssueSourceInput {
  id?: string;
  provider: string;
  baseUrl?: string;
  repo: string;
  labels?: string[];
  enabled?: boolean;
}

/** Link from an imported card to its issue. */
export interface CardExternal {
  sourceId: string;
  provider: string;
  repo: string;
  externalId: string;
  number: number;
  url: string;
  updatedAt: string;
  /** Set once after the write-back attempt in Done; never cleared. */
  writeBack?: "done" | "failed";
}

/** Issue as returned by a provider, normalized. In memory only. */
export interface ExternalIssue {
  externalId: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  state: "open" | "closed";
  updatedAt: string;
}

/** Live (non-persisted) state of a source, sent in the project snapshot. */
export interface IssueSourceStatus {
  hasToken: boolean;
  syncing: boolean;
  lastSyncAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  writeBackError?: string;
  writeBackErrorAt?: string;
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export function validRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** http(s) URL without trailing slash, or undefined when invalid. */
export function normalizeBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Trimmed, deduped (case-insensitive) non-empty labels; undefined when none. */
export function normalizeLabels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of raw) {
    if (typeof l !== "string") continue;
    const t = l.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalizes one stored source; undefined when malformed. Unknown provider ids are kept (newer version). */
export function normalizeIssueSource(raw: unknown): IssueSource | undefined {
  if (!isObj(raw)) return undefined;
  const { id, provider, repo } = raw;
  if (typeof id !== "string" || !id) return undefined;
  if (typeof provider !== "string" || !provider) return undefined;
  if (typeof repo !== "string" || !validRepo(repo.trim())) return undefined;
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  if (!baseUrl) return undefined;
  const labels = normalizeLabels(raw.labels);
  const importedIds = Array.isArray(raw.importedIds) ? [...new Set(raw.importedIds.filter((x): x is string => typeof x === "string"))] : [];
  return {
    id,
    provider,
    baseUrl,
    repo: repo.trim(),
    ...(labels ? { labels } : {}),
    enabled: raw.enabled !== false,
    importedIds,
  };
}

/** Normalizes the board's `issueSources`; undefined when none is valid. Duplicate ids keep the first. */
export function normalizeIssueSources(raw: unknown): IssueSource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueSource[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    const s = normalizeIssueSource(r);
    if (!s || ids.has(s.id)) continue;
    ids.add(s.id);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

/** Normalizes a card's `external`; undefined when a required field is missing. */
export function normalizeCardExternal(raw: unknown): CardExternal | undefined {
  if (!isObj(raw)) return undefined;
  const { sourceId, provider, repo, externalId, number, url, updatedAt, writeBack } = raw;
  for (const v of [sourceId, provider, repo, externalId, url, updatedAt]) if (typeof v !== "string" || !v) return undefined;
  if (!Number.isInteger(number) || (number as number) < 1) return undefined;
  return {
    sourceId: sourceId as string,
    provider: provider as string,
    repo: repo as string,
    externalId: externalId as string,
    number: number as number,
    url: url as string,
    updatedAt: updatedAt as string,
    ...(writeBack === "done" || writeBack === "failed" ? { writeBack } : {}),
  };
}

/** True when the issue passes the source's label filter (no filter = every issue). */
export function matchesLabels(issue: Pick<ExternalIssue, "labels">, labels: string[] | undefined): boolean {
  if (!labels || labels.length === 0) return true;
  const want = new Set(labels.map((l) => l.toLowerCase()));
  return issue.labels.some((l) => want.has(l.toLowerCase()));
}

/** Key of a token in the global settings: one token per provider and host. */
export function tokenKey(provider: string, baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {}
  return `${provider}:${host.toLowerCase()}`;
}

/** Base URL actually used for a source input: the given one, else the provider default. */
export function effectiveBaseUrl(info: ProviderInfo, raw: string | undefined): string | undefined {
  return normalizeBaseUrl(raw) ?? (info.baseUrlRequired ? undefined : info.defaultBaseUrl);
}

/** Provider, base URL and repo guessed from a git remote URL; undefined when nothing matches. */
export function parseGitRemote(remote: string): { provider: string; baseUrl: string; repo: string } | undefined {
  const s = remote.trim();
  let host: string | undefined;
  let path: string | undefined;
  let https = false;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(s);
      if (u.protocol === "https:" || u.protocol === "http:") https = true;
      else if (u.protocol !== "ssh:" && u.protocol !== "git:") return undefined;
      host = u.host;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  if (!host || !path) return undefined;
  const repo = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!validRepo(repo)) return undefined;
  const h = host.toLowerCase();
  const matched = PROVIDERS.find((p) => p.matchHosts?.some((m) => m === h || m === h.replace(/:\d+$/, "")));
  if (matched?.remoteBaseUrl) return { provider: matched.id, baseUrl: matched.remoteBaseUrl, repo };
  if (!https) return undefined;
  const fallback = PROVIDERS.find((p) => p.fallbackForHttps);
  if (!fallback) return undefined;
  return { provider: fallback.id, baseUrl: `https://${host}`, repo };
}
