import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings } from "../src/shared/types.ts";
import { SettingsContent } from "../src/web/SettingsModal.tsx";

const base: Settings = {
  maxParallel: 3,
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: false,
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
