import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueSource } from "../src/shared/issues.ts";
import type { Settings } from "../src/shared/types.ts";
import {
  confirmResync,
  draftFromDetect,
  draftFromSource,
  draftToInput,
  IssueSourcesEditor,
  resyncChanged,
  saveDraft,
  toInput,
} from "../src/web/IssueSourcesEditor.tsx";
import { SettingsContent } from "../src/web/SettingsModal.tsx";

const src: IssueSource = {
  id: "src_a",
  provider: "github",
  baseUrl: "https://api.github.com",
  repo: "o/r",
  labels: ["bug"],
  enabled: true,
  importedIds: ["1"],
};

const settings: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
};

test("ui-sources-editor: rows show the repo, the errors and the no-token hint", () => {
  const html = renderToStaticMarkup(
    <IssueSourcesEditor
      project="/p"
      sources={[src]}
      status={{
        src_a: {
          hasToken: false,
          syncing: false,
          lastError: "invalid token",
          lastErrorAt: new Date().toISOString(),
          writeBackError: "o/r#2: forbidden",
        },
      }}
      canSync
    />,
  );
  expect(html).toContain("o/r");
  expect(html).toContain("provider-github");
  expect(html).toContain("issue-source-error");
  expect(html).toContain("invalid token");
  expect(html).toContain("o/r#2: forbidden");
  expect(html).toContain("Pas de jeton");
});

test("ui-sources-editor: shown in the project section of the settings", () => {
  const html = renderToStaticMarkup(
    <SettingsContent
      value={settings}
      onChange={() => {}}
      currentProject="/p"
      projectMaxParallel={3}
      issues={{ sources: [], canSync: true }}
    />,
  );
  expect(html).toContain("Sources de tickets");
  expect(html).toContain("issue-sources-empty");
});

test("ui-sources-editor: the form never shows a saved token", () => {
  const html = renderToStaticMarkup(
    <IssueSourcesEditor
      project="/p"
      sources={[src]}
      status={{ src_a: { hasToken: true, syncing: false } }}
      canSync={false}
      initialDraft={draftFromSource(src)}
    />,
  );
  expect(html).toContain('type="password"');
  expect(html).toContain("Jeton enregistré");
  expect(html).toContain("Supprimer le jeton");
});

test("ui-sources-editor: Add pre-fills from the detected remote", () => {
  expect(draftFromDetect({ provider: "github", baseUrl: "https://api.github.com", repo: "o/r" })).toMatchObject({
    provider: "github",
    baseUrl: "",
    repo: "o/r",
  });
  expect(draftFromDetect({ provider: "gitea", baseUrl: "https://g.example.com", repo: "a/b" })).toMatchObject({
    provider: "gitea",
    baseUrl: "https://g.example.com",
    repo: "a/b",
  });
  expect(draftFromDetect({}).repo).toBe("");
});

test("ui-sources-editor: saving with an empty token field sends no token", async () => {
  const sent: string[] = [];
  const client = {
    saveIssueToken: async (provider: string, baseUrl: string, token: string) => {
      sent.push(`token ${provider} ${baseUrl} ${token}`);
      return { ok: true };
    },
    saveIssueSources: async (_p: string, sources: unknown) => {
      sent.push(`sources ${JSON.stringify(sources)}`);
      return {} as never;
    },
  };
  await saveDraft(client, "/p", [src], { ...draftFromSource(src), labels: "bug, ui" });
  expect(sent).toEqual([
    `sources ${JSON.stringify([{ id: "src_a", provider: "github", repo: "o/r", labels: ["bug", "ui"], enabled: true }])}`,
  ]);
  sent.length = 0;
  await saveDraft(client, "/p", [src], { ...draftFromDetect({}), repo: "x/y", token: " t0k " });
  expect(sent[0]).toBe("token github https://api.github.com t0k");
  expect(sent[1]).toContain('"repo":"x/y"');
  expect(sent[1]).toContain('"id":"src_a"');
});

test("ui-query-field", () => {
  const q = { ...src, query: "is:issue assignee:@me" };
  expect(draftToInput(draftFromSource(q)).query).toBe("is:issue assignee:@me");
  expect(toInput(q).query).toBe("is:issue assignee:@me");
  expect(draftToInput({ ...draftFromSource(q), provider: "gitea", baseUrl: "https://g.example.com" })).not.toHaveProperty("query");
  const html = renderToStaticMarkup(<IssueSourcesEditor project="/p" sources={[q]} status={{}} canSync />);
  expect(html).toContain("issue-source-query");
});

test("ui-resync", async () => {
  const input = (d: Partial<ReturnType<typeof draftFromSource>>) => draftToInput({ ...draftFromSource(src), ...d });
  // New source, or nothing that changes what is imported: no prompt.
  expect(resyncChanged(undefined, input({}))).toBe(false);
  expect(resyncChanged(src, input({}))).toBe(false);
  expect(resyncChanged(src, input({ enabled: false }))).toBe(false);
  expect(resyncChanged({ ...src, labels: ["bug", "ui"] }, input({ labels: " UI , Bug " }))).toBe(false);
  expect(resyncChanged(src, input({ query: "   " }))).toBe(false);
  expect(resyncChanged(src, input({ baseUrl: "https://api.github.com/" }))).toBe(false);
  // Labels, query or target changed: prompt.
  expect(resyncChanged(src, input({ labels: "ui" }))).toBe(true);
  expect(resyncChanged(src, input({ labels: "" }))).toBe(true);
  expect(resyncChanged(src, input({ query: "is:issue" }))).toBe(true);
  expect(resyncChanged(src, input({ repo: "o/other" }))).toBe(true);
  expect(resyncChanged(src, input({ provider: "gitea", baseUrl: "https://g.example.com" }))).toBe(true);

  const calls: string[] = [];
  const client = {
    resyncIssues: async (project: string, id: string) => {
      calls.push(`${project} ${id}`);
      return {} as never;
    },
  };
  const asked: string[] = [];
  expect(
    await confirmResync(
      client,
      "/p",
      "src_a",
      (m) => {
        asked.push(m);
        return false;
      },
      "sure?",
    ),
  ).toBe(false);
  expect(calls).toEqual([]);
  expect(await confirmResync(client, "/p", "src_a", () => true, "sure?")).toBe(true);
  expect(calls).toEqual(["/p src_a"]);
  expect(asked).toEqual(["sure?"]);

  const html = renderToStaticMarkup(<IssueSourcesEditor project="/p" sources={[src]} status={{}} canSync />);
  expect(html).toContain("issue-source-resync");
});
