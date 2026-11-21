// GitHub (github.com and GitHub Enterprise) issues. The source's baseUrl is the API root.

import type { ExternalIssue, IssueSource } from "../../shared/issues.ts";
import { type IssueProvider, type RequestOptions, repoPath, requestJson, requestOrNull } from "./provider.ts";

interface GhIssue {
  number: number;
  title?: string | null;
  body?: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
  repository_url?: string;
}

const MAX_PAGES = 50;

const opts = (token?: string, extra: Partial<RequestOptions> = {}): RequestOptions => ({
  token,
  authHeader: (t) => `Bearer ${t}`,
  headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  ...extra,
});

function toIssue(i: GhIssue): ExternalIssue {
  return {
    externalId: String(i.number),
    number: i.number,
    title: i.title ?? "",
    body: i.body ?? "",
    url: i.html_url,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    state: i.state === "closed" ? "closed" : "open",
    updatedAt: i.updated_at,
  };
}

/** URL of the `rel="next"` entry of a Link header. */
function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

const issueUrl = (src: IssueSource, n: number) => `${src.baseUrl}/repos/${repoPath(src.repo)}/issues/${n}`;

/** True when a search hit belongs to the source's repository (several `repo:` qualifiers are OR-ed by GitHub). */
const inRepo = (i: GhIssue, repo: string) => !!i.repository_url?.toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`);

export const github: IssueProvider = {
  async listOpenIssues(src, token) {
    const out: ExternalIssue[] = [];
    if (src.query) {
      const q = encodeURIComponent(`repo:${src.repo} ${src.query}`);
      let next: string | undefined = `${src.baseUrl}/search/issues?q=${q}&per_page=100`;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const res: { data: { items?: GhIssue[] } | null; headers: Headers } = await requestJson<{ items?: GhIssue[] }>(
          next,
          opts(token),
        );
        for (const i of res.data?.items ?? [])
          if (!i.pull_request && i.state === "open" && inRepo(i, src.repo)) out.push(toIssue(i));
        next = nextLink(res.headers.get("link"));
      }
      return out;
    }
    let url: string | undefined = `${src.baseUrl}/repos/${repoPath(src.repo)}/issues?state=open&per_page=100`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: { data: GhIssue[]; headers: Headers } = await requestJson<GhIssue[]>(url, opts(token));
      for (const i of res.data ?? []) if (!i.pull_request) out.push(toIssue(i));
      url = nextLink(res.headers.get("link"));
    }
    return out;
  },
  async getIssue(src, token, number) {
    const i = await requestOrNull<GhIssue>(issueUrl(src, number), opts(token));
    return i && !i.pull_request ? toIssue(i) : null;
  },
  async comment(src, token, number, text) {
    await requestJson(`${issueUrl(src, number)}/comments`, opts(token, { method: "POST", body: { body: text } }));
  },
  async close(src, token, number) {
    await requestJson(issueUrl(src, number), opts(token, { method: "PATCH", body: { state: "closed" } }));
  },
};
