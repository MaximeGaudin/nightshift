import { afterEach, expect, test } from "bun:test";
import { gitea } from "../src/server/issues/gitea.ts";
import { github } from "../src/server/issues/github.ts";
import { ProviderError, setFetchForTests } from "../src/server/issues/provider.ts";
import type { IssueSource } from "../src/shared/issues.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let calls: Call[] = [];

function fake(handler: (c: Call) => Response | Promise<Response>) {
  calls = [];
  setFetchForTests(async (url, init) => {
    const c: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(c);
    return handler(c);
  });
}

afterEach(() => setFetchForTests(null));

const gh: IssueSource = { id: "s", provider: "github", baseUrl: "https://api.github.com", repo: "o/r", enabled: true, importedIds: [] };
const gt: IssueSource = { id: "t", provider: "gitea", baseUrl: "https://g.example.com", repo: "o/r", enabled: true, importedIds: [] };

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  html_url: `https://github.com/o/r/issues/${n}`,
  state: "open",
  updated_at: "2026-01-01T00:00:00Z",
  labels: [{ name: "bug" }],
  ...extra,
});

test("github-pagination-and-prs", async () => {
  fake((c) => {
    if (c.url.includes("page=2")) return Response.json([issue(3)], { headers: {} });
    return Response.json([issue(1), issue(2, { pull_request: { url: "x" } })], {
      headers: { link: '<https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=2>; rel="next", <https://x>; rel="last"' },
    });
  });
  const list = await github.listOpenIssues(gh, "tok");
  expect(list.map((i) => i.number)).toEqual([1, 3]);
  expect(list[0]).toEqual({
    externalId: "1",
    number: 1,
    title: "Issue 1",
    body: "Body 1",
    url: "https://github.com/o/r/issues/1",
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/issues?state=open&per_page=100");
  expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
  expect(calls.length).toBe(2);
});

test("github-unauthenticated-has-no-auth-header", async () => {
  fake(() => Response.json([]));
  await github.listOpenIssues(gh);
  expect(calls[0]?.headers.Authorization).toBeUndefined();
});

test("provider-errors", async () => {
  fake(() => new Response(JSON.stringify({ message: "Bad credentials secret-xyz" }), { status: 401 }));
  const err = await github.listOpenIssues(gh, "secret-xyz").catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.kind).toBe("auth");
  expect(err.message).toBe("invalid token");
  expect(err.message).not.toContain("secret-xyz");

  fake(() => new Response("{}", { status: 404 }));
  expect((await github.listOpenIssues(gh, "t").catch((e) => e)).kind).toBe("notFound");
  expect(await github.getIssue(gh, "t", 9)).toBeNull();

  fake(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
  expect((await github.listOpenIssues(gh).catch((e) => e)).kind).toBe("rateLimit");

  fake(() => {
    throw new Error("connect ECONNREFUSED with secret-xyz");
  });
  const net = await gitea.listOpenIssues(gt, "secret-xyz").catch((e) => e);
  expect(net.kind).toBe("network");
  expect(net.message).not.toContain("secret-xyz");
});

test("github-comment-and-close", async () => {
  fake(() => Response.json({}));
  await github.comment(gh, "tok", 4, "hello");
  await github.close(gh, "tok", 4);
  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
    ["POST", "https://api.github.com/repos/o/r/issues/4/comments", { body: "hello" }],
    ["PATCH", "https://api.github.com/repos/o/r/issues/4", { state: "closed" }],
  ]);
});

test("gitea-requests", async () => {
  const full = Array.from({ length: 50 }, (_, i) => issue(i + 1));
  fake((c) => (c.url.includes("page=1") ? Response.json(full) : Response.json([issue(51)])));
  const list = await gitea.listOpenIssues(gt, "tok");
  expect(list.length).toBe(51);
  expect(calls[0]?.url).toBe("https://g.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50&page=1");
  expect(calls[0]?.headers.Authorization).toBe("token tok");
  expect(calls.length).toBe(2);

  fake(() => Response.json({}));
  await gitea.comment(gt, "tok", 7, "done");
  await gitea.close(gt, "tok", 7);
  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
    ["POST", "https://g.example.com/api/v1/repos/o/r/issues/7/comments", { body: "done" }],
    ["PATCH", "https://g.example.com/api/v1/repos/o/r/issues/7", { state: "closed" }],
  ]);
  fake(() => Response.json(issue(7, { state: "closed" })));
  expect((await gitea.getIssue(gt, undefined, 7))?.state).toBe("closed");
});

const ghq: IssueSource = { ...gh, query: "is:issue assignee:@me" };
const hit = (n: number, extra: Record<string, unknown> = {}) => ({
  ...issue(n),
  repository_url: "https://api.github.com/repos/O/R",
  ...extra,
});

test("gh-search-url", async () => {
  fake((c) => {
    if (c.url.includes("page=2")) return Response.json({ items: [hit(3)] });
    return Response.json(
      { items: [hit(1)] },
      { headers: { link: '<https://api.github.com/search/issues?q=x&per_page=100&page=2>; rel="next"' } },
    );
  });
  const list = await github.listOpenIssues(ghq, "tok");
  expect(list.map((i) => i.number)).toEqual([1, 3]);
  const u = new URL(calls[0]?.url as string);
  expect(u.pathname).toBe("/search/issues");
  expect(u.searchParams.get("q")).toBe("repo:o/r is:issue assignee:@me");
  expect(calls.length).toBe(2);
});

test("gh-search-filters", async () => {
  fake(() =>
    Response.json({
      items: [
        hit(1),
        hit(2, { pull_request: { url: "x" } }),
        hit(3, { state: "closed" }),
        hit(4, { repository_url: "https://api.github.com/repos/other/x" }),
      ],
    }),
  );
  expect((await github.listOpenIssues(ghq, "tok")).map((i) => i.number)).toEqual([1]);
});

test("gh-no-query-regression", async () => {
  fake(() => Response.json([issue(1)]));
  await github.listOpenIssues(gh, "tok");
  expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/issues?state=open&per_page=100");
});

test("gh-search-422", async () => {
  fake(() => Response.json({ message: "Validation Failed" }, { status: 422 }));
  await expect(github.listOpenIssues(ghq, "tok")).rejects.toThrow("Validation Failed");
});
