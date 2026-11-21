// Gitea (and Forgejo) issues. The source's baseUrl is the instance root; the API lives under /api/v1.

import type { ExternalIssue, IssueSource } from "../../shared/issues.ts";
import { type IssueProvider, type RequestOptions, repoPath, requestJson, requestOrNull } from "./provider.ts";

interface GiteaIssue {
  number: number;
  title?: string | null;
  body?: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  labels?: { name?: string }[] | null;
  pull_request?: unknown;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 100;

const opts = (token?: string, extra: Partial<RequestOptions> = {}): RequestOptions => ({
  token,
  authHeader: (t) => `token ${t}`,
  ...extra,
});

function toIssue(i: GiteaIssue): ExternalIssue {
  return {
    externalId: String(i.number),
    number: i.number,
    title: i.title ?? "",
    body: i.body ?? "",
    url: i.html_url,
    labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    state: i.state === "closed" ? "closed" : "open",
    updatedAt: i.updated_at,
  };
}

const api = (src: IssueSource) => `${src.baseUrl}/api/v1/repos/${repoPath(src.repo)}`;

export const gitea: IssueProvider = {
  async listOpenIssues(src, token) {
    const out: ExternalIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await requestJson<GiteaIssue[]>(
        `${api(src)}/issues?state=open&type=issues&limit=${PAGE_SIZE}&page=${page}`,
        opts(token),
      );
      const items = data ?? [];
      for (const i of items) if (!i.pull_request) out.push(toIssue(i));
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  },
  async getIssue(src, token, number) {
    const i = await requestOrNull<GiteaIssue>(`${api(src)}/issues/${number}`, opts(token));
    return i && !i.pull_request ? toIssue(i) : null;
  },
  async comment(src, token, number, text) {
    await requestJson(`${api(src)}/issues/${number}/comments`, opts(token, { method: "POST", body: { body: text } }));
  },
  async close(src, token, number) {
    await requestJson(`${api(src)}/issues/${number}`, opts(token, { method: "PATCH", body: { state: "closed" } }));
  },
};
