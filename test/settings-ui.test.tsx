import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings } from "../src/shared/types.ts";
import { SettingsContent, saveSettingsAndProject, settingsDirty } from "../src/web/SettingsModal.tsx";

const base: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
};

const render = (s: Settings, current?: string) =>
  renderToStaticMarkup(<SettingsContent value={s} onChange={() => {}} currentProject={current} onOpenProject={() => {}} />);

test("settings-sections: three titled sections, one Ouvrir button per recent project", () => {
  const html = render({ ...base, recentProjects: ["/a/one", "/a/two"] }, "/a/one");
  for (const title of ["Agents", "Claude", "Projets récents"]) expect(html).toContain(`>${title}</h3>`);
  expect(html.match(/>Ouvrir</g)?.length).toBe(2);
  expect(html).toContain("Projet courant");
  expect(html).not.toContain("recent-empty");
});

test("settings-sections: empty state without recent projects", () => {
  const html = render(base);
  expect(html).toContain("Aucun projet récent");
  expect(html).not.toContain(">Ouvrir<");
});

test("settings-sections: bypassPermissions shows a warning alert", () => {
  expect(render(base)).not.toContain('role="alert"');
  expect(render({ ...base, permissionMode: "bypassPermissions" })).toContain('role="alert"');
});

test("settings-dirty: only editable fields count as unsaved changes", () => {
  expect(settingsDirty(base, { ...base })).toBe(false);
  expect(settingsDirty(base, { ...base, recentProjects: ["/x"] })).toBe(false);
  expect(settingsDirty(base, { ...base, model: "opus" })).toBe(true);
  expect(settingsDirty(base, { ...base, soundNotifications: true })).toBe(true);
});

test("language-switch-ui: Settings shows the Language select with Auto / English / Français and the stored value", async () => {
  const { languageOptions } = await import("../src/web/SettingsModal.tsx");
  expect(languageOptions().map((o) => o.label)).toEqual(["Auto", "English", "Français"]);
  const html = render({ ...base, language: "en" });
  expect(html).toContain('id="set-language"');
  expect(html).toContain("Langue");
  expect(html).toMatch(/id="set-language"[^>]*>.*?<span[^>]*>English<\/span>/s);
  expect(render({ ...base, language: "auto" })).toMatch(/id="set-language"[^>]*>.*?<span[^>]*>Auto<\/span>/s);
  expect(settingsDirty(base, { ...base, language: "fr" })).toBe(true);
});

test("settings-ui-project-section: no global cap, the project's cap is editable", () => {
  const html = renderToStaticMarkup(
    <SettingsContent
      value={base}
      onChange={() => {}}
      currentProject="/a/one"
      projectMaxParallel={4}
      onProjectMaxParallelChange={() => {}}
    />,
  );
  expect(html).not.toContain("Plafond global");
  expect(html).toContain(">Ce projet</h3>");
  expect(html).toContain("/a/one");
  expect(html).toContain("Agents en parallèle dans ce projet");
  expect(html).toMatch(/id="set-project-parallel"[^>]*value="4"/);
  // Without an open project there is nothing to set.
  expect(render(base)).not.toContain("set-project-parallel");
});

test("settings-ui-project-section: saving writes the board only when the project cap changed", async () => {
  const calls: [string, unknown][] = [];
  const client = {
    saveSettings: async (s: Partial<Settings>) => {
      calls.push(["settings", s]);
      return base;
    },
    saveBoard: async (project: string, patch: object) => {
      calls.push(["board", { project, ...patch }]);
      return {} as never;
    },
  };
  await saveSettingsAndProject(client, base, { path: "/a/one", saved: 4, draft: 2 });
  expect(calls.map(([k]) => k)).toEqual(["settings", "board"]);
  expect(calls[1][1]).toEqual({ project: "/a/one", maxParallel: 2 });
  expect("maxParallel" in (calls[0][1] as object)).toBe(false);
  calls.length = 0;
  await saveSettingsAndProject(client, base, { path: "/a/one", saved: 4, draft: 4 });
  expect(calls.map(([k]) => k)).toEqual(["settings"]);
  // A failed settings write stops before the board one.
  calls.length = 0;
  const failing = { ...client, saveSettings: async () => Promise.reject(new Error("nope")) };
  await expect(saveSettingsAndProject(failing, base, { path: "/a/one", saved: 4, draft: 2 })).rejects.toThrow("nope");
  expect(calls).toEqual([]);
});

test("settings-dirty: a changed project cap counts as unsaved", () => {
  expect(settingsDirty(base, base, 3, 3)).toBe(false);
  expect(settingsDirty(base, base, 3, 5)).toBe(true);
});

test("header-project-count: running cards and quick runs over the project cap", async () => {
  const { activeAgents } = await import("../src/web/App.tsx");
  const snap = {
    live: { c1: "running", c2: "queued" },
    quickRuns: [{ status: "running" }, { status: "queued" }],
    maxParallel: 5,
  } as unknown as Parameters<typeof activeAgents>[0];
  expect(activeAgents(snap)).toEqual({ running: 2, max: 5 });
});
