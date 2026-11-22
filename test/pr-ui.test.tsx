// Pull request settings rows and PR link on the card tile and in the card dialog.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrCiStatus, PullRequestSettings } from "../src/shared/pullRequests.ts";
import type { Card, Settings } from "../src/shared/types.ts";
import { CardPrLink } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";
import { SettingsContent, saveSettingsAndProject, settingsDirty } from "../src/web/SettingsModal.tsx";

const settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  effort: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
  teamclaudeEnabled: false,
  teamclaudeUrl: "http://localhost:3456",
  cpuThrottleEnabled: true,
  cpuThrottleMaxPercent: 85,
} as Settings;
const auto: PullRequestSettings = { pullRequests: "auto", mergeMethod: "merge", autoMerge: false };

const renderSettings = (pr?: PullRequestSettings) =>
  renderToStaticMarkup(
    <SettingsContent
      value={settings}
      onChange={() => {}}
      currentProject="/a/one"
      projectMaxParallel={2}
      onProjectMaxParallelChange={() => {}}
      pullRequests={pr}
      onPullRequestsChange={() => {}}
    />,
  );

test("pull request rows show in This project; merge method and auto-merge hide when off", () => {
  const html = renderSettings(auto);
  expect(html).toContain('id="set-pull-requests"');
  expect(html).toContain("Automatique — si GitHub et gh sont disponibles");
  expect(html).toContain('id="set-merge-method"');
  expect(html).toContain('id="set-auto-merge"');
  const off = renderSettings({ ...auto, pullRequests: "off" });
  expect(off).toContain("Désactivé — merge local");
  expect(off).not.toContain('id="set-merge-method"');
  expect(off).not.toContain('id="set-auto-merge"');
  expect(renderSettings(undefined)).not.toContain("set-pull-requests");
});

test("saving writes the pull request settings only when they changed", async () => {
  const calls: unknown[] = [];
  const client = {
    saveSettings: async () => settings,
    saveBoard: async () => ({}) as never,
    setPullRequests: async (project: string, pr: PullRequestSettings) => {
      calls.push({ project, ...pr });
      return {} as never;
    },
  };
  const project = { path: "/a/one", saved: 2, draft: 2 };
  await saveSettingsAndProject(client, settings, { ...project, pr: { saved: auto, draft: auto } });
  expect(calls).toEqual([]);
  await saveSettingsAndProject(client, settings, { ...project, pr: { saved: auto, draft: { ...auto, autoMerge: true } } });
  expect(calls).toEqual([{ project: "/a/one", pullRequests: "auto", mergeMethod: "merge", autoMerge: true }]);
  expect(settingsDirty(settings, settings, 2, 2, "required", "required", auto, { ...auto, mergeMethod: "squash" })).toBe(true);
  expect(settingsDirty(settings, settings, 2, 2, "required", "required", auto, { ...auto })).toBe(false);
});

const card = (description: string) => ({ id: "card_1", number: 3, title: "Hello", description, columnId: "c" }) as unknown as Card;

test("the PR link shows on the tile and in the dialog, only for an http(s) URL", () => {
  const url = "https://github.com/o/r/pull/3";
  const withPr = card(`## Review\n\n- Findings: none\n- PR: ${url}\n`);
  expect(renderToStaticMarkup(<CardTile project="/p" card={withPr} onOpen={() => {}} />)).toContain(`href="${url}"`);
  expect(renderToStaticMarkup(<CardPrLink card={withPr} />)).toContain(`href="${url}"`);
  for (const d of ["## Review\n\n- PR: javascript:alert(1)\n", "## Review\n\n- PR: failed — gh\n", ""]) {
    expect(renderToStaticMarkup(<CardTile project="/p" card={card(d)} onOpen={() => {}} />)).not.toContain("card-pr");
    expect(renderToStaticMarkup(<CardPrLink card={card(d)} />)).toBe("");
  }
});

const prUrl = "https://github.com/o/r/pull/3";
const withPr = () => card(`## Review\n\n- PR: ${prUrl}\n`);
const ciStatus = (state: PrCiStatus["state"], failed: PrCiStatus["failed"] = [], url = prUrl): PrCiStatus => ({
  url,
  state,
  failed,
  checkedAt: "2026-01-01T00:00:00.000Z",
});

test("the tile shows a CI dot per state, and the failed check names in the tooltip", () => {
  for (const state of ["pass", "pending", "fail", "none"] as const) {
    const html = renderToStaticMarkup(<CardTile project="/p" card={withPr()} ci={ciStatus(state)} onOpen={() => {}} />);
    expect(html).toContain(`data-ci="${state}"`);
  }
  const failed = [
    { name: "lint", link: "https://github.com/o/r/actions/runs/1/job/2" },
    { name: "unit", link: "" },
  ];
  const html = renderToStaticMarkup(<CardTile project="/p" card={withPr()} ci={ciStatus("fail", failed)} onOpen={() => {}} />);
  expect(html).toMatch(/title="CI ?: [^"]*\(lint, unit\)/);
  // Merged or closed: no dot; a status of another URL, or none, shows nothing new.
  for (const ci of [ciStatus("merged"), ciStatus("closed"), ciStatus("pass", [], "https://github.com/o/r/pull/9"), undefined]) {
    expect(renderToStaticMarkup(<CardTile project="/p" card={withPr()} ci={ci} onOpen={() => {}} />)).not.toContain("data-ci");
  }
  expect(renderToStaticMarkup(<CardTile project="/p" card={card("")} ci={ciStatus("pass")} onOpen={() => {}} />)).not.toContain("data-ci");
});

test("the dialog chip links each failed check to its run", () => {
  const link = "https://github.com/o/r/actions/runs/1/job/2";
  const html = renderToStaticMarkup(
    <CardPrLink
      card={withPr()}
      ci={ciStatus("fail", [
        { name: "lint", link },
        { name: "unit", link: "javascript:alert(1)" },
      ])}
    />,
  );
  expect(html).toContain(`href="${link}"`);
  expect(html).toContain(">lint<");
  expect(html).toContain("unit");
  expect(html).not.toContain("javascript:");
  expect(renderToStaticMarkup(<CardPrLink card={withPr()} ci={ciStatus("pass")} />)).toMatch(/CI ?: (passing|succès)/);
  expect(renderToStaticMarkup(<CardPrLink card={withPr()} />)).not.toContain("data-ci");
});
