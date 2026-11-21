import { expect, test } from "bun:test";
import { normalizeBoard } from "../src/server/store.ts";
import { matchesLabels, normalizeIssueSources, parseGitRemote, tokenKey } from "../src/shared/issues.ts";

const validSource = {
  id: "src_a",
  provider: "github",
  baseUrl: "https://api.github.com/",
  repo: "o/r",
  labels: [" bug ", "Bug", ""],
  enabled: true,
  importedIds: ["1", "1", 2, "3"],
};

test("issues-normalize", () => {
  const raw = {
    version: 1,
    name: "b",
    columns: [],
    cards: [
      {
        id: "card_1",
        number: 1,
        title: "a",
        columnId: "col_backlog",
        external: { sourceId: "src_a", provider: "github", repo: "o/r", externalId: "1", number: 1, url: "https://x/1", updatedAt: "t" },
      },
      { id: "card_2", number: 2, title: "b", columnId: "col_backlog", external: { sourceId: "src_a", provider: "github" } },
    ],
    nextCardNumber: 3,
    issueSources: [
      validSource,
      { id: "src_bad", provider: "github", baseUrl: "https://api.github.com", repo: "norepo", enabled: true },
      { id: "src_new", provider: "gitlab", baseUrl: "https://gitlab.example.com", repo: "a/b", enabled: false, importedIds: [] },
    ],
  };
  const board = normalizeBoard(raw, "b");
  expect(board.issueSources?.map((s) => s.id)).toEqual(["src_a", "src_new"]);
  const a = board.issueSources?.[0];
  expect(a?.baseUrl).toBe("https://api.github.com");
  expect(a?.labels).toEqual(["bug"]);
  expect(a?.importedIds).toEqual(["1", "3"]);
  expect(board.issueSources?.[1]?.enabled).toBe(false);
  expect(board.cards[0]?.external?.externalId).toBe("1");
  expect(board.cards[1]?.external).toBeUndefined();
  const again = normalizeBoard(JSON.parse(JSON.stringify(board)), "b");
  expect(again).toEqual(board);
});

test("issues-normalize-empty", () => {
  expect(normalizeIssueSources([])).toBeUndefined();
  expect(normalizeIssueSources("x")).toBeUndefined();
  expect(normalizeBoard({ version: 1, name: "b", columns: [], cards: [] }, "b").issueSources).toBeUndefined();
});

test("git-remote-parse", () => {
  expect(parseGitRemote("git@github.com:o/r.git")).toEqual({ provider: "github", baseUrl: "https://api.github.com", repo: "o/r" });
  expect(parseGitRemote("https://github.com/o/r")).toEqual({ provider: "github", baseUrl: "https://api.github.com", repo: "o/r" });
  expect(parseGitRemote("ssh://git@github.com/o/r")).toEqual({ provider: "github", baseUrl: "https://api.github.com", repo: "o/r" });
  expect(parseGitRemote("https://git.example.com/o/r.git")).toEqual({ provider: "gitea", baseUrl: "https://git.example.com", repo: "o/r" });
  expect(parseGitRemote("git@git.example.com:o/r.git")).toBeUndefined();
  expect(parseGitRemote("file:///x")).toBeUndefined();
});

test("matches-labels", () => {
  expect(matchesLabels({ labels: [] }, undefined)).toBe(true);
  expect(matchesLabels({ labels: ["bug"] }, ["Bug"])).toBe(true);
  expect(matchesLabels({ labels: ["feature"] }, ["Bug"])).toBe(false);
});

test("token-key", () => {
  expect(tokenKey("github", "https://API.github.com/")).toBe("github:api.github.com");
  expect(tokenKey("gitea", "https://g.example.com:3000")).toBe("gitea:g.example.com:3000");
});
