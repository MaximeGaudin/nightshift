import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, ProjectSnapshot, SkillInfo } from "../src/shared/types.ts";
import { CardSourceLink } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";
import { buildCommands } from "../src/web/commands.ts";

const manual = { id: "card_1", number: 1, title: "Hello", description: "", columnId: "col_backlog" } as unknown as Card;
const imported = {
  ...manual,
  id: "card_2",
  number: 2,
  external: {
    sourceId: "src_a",
    provider: "github",
    repo: "o/r",
    externalId: "7",
    number: 7,
    url: "https://github.com/o/r/issues/7",
    updatedAt: "t",
  },
} as Card;

test("ui-source-marker: tile icon only on imported cards", () => {
  const tile = (card: Card) => renderToStaticMarkup(<CardTile project="/p" card={card} onOpen={() => {}} />);
  const html = tile(imported);
  expect(html).toContain("card-source");
  expect(html).toContain("provider-github");
  expect(html).toContain('title="GitHub o/r#7"');
  expect(tile(manual)).not.toContain("card-source");
});

test("ui-source-marker: detail link to the issue", () => {
  const html = renderToStaticMarkup(<CardSourceLink card={imported} />);
  expect(html).toContain('href="https://github.com/o/r/issues/7"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("o/r#7");
  expect(html).toContain("provider-github");
  expect(renderToStaticMarkup(<CardSourceLink card={manual} />)).toBe("");
  const unsafe = { ...imported, external: { ...imported.external, url: "javascript:alert(1)" } } as Card;
  expect(renderToStaticMarkup(<CardSourceLink card={unsafe} />)).not.toContain("href=");
});

test("ui-source-marker: unknown provider gets the fallback icon", () => {
  const other = { ...imported, external: { ...imported.external, provider: "gitlab" } } as Card;
  expect(renderToStaticMarkup(<CardSourceLink card={other} />)).toContain("provider-gitlab");
});

test("ui-source-marker: palette lists Sync issues only with sources", () => {
  const snap = (extra: object) =>
    ({
      path: "/p",
      board: { name: "b", columns: [{ id: "col_backlog", name: "Backlog", type: "inert" }], cards: [], ...extra },
      live: {},
      flow: { fastForward: false, paused: false },
    }) as unknown as ProjectSnapshot;
  const cmds = (extra: object, more: object = {}) =>
    buildCommands({ snap: { ...snap(extra), ...more }, recentProjects: [], skills: [] as SkillInfo[] });
  expect(cmds({}).find((c) => c.id === "issuesSync")).toBeUndefined();
  const sync = cmds({ issueSources: [{ id: "s" }] }).find((c) => c.id === "issuesSync");
  expect(sync?.label).toBe("Synchroniser les tickets");
  expect(sync?.action).toEqual({ type: "issuesSync" });
  expect(sync?.disabled).toBe(false);
  expect(cmds({ issueSources: [{ id: "s" }] }, { agentsDisabled: true }).find((c) => c.id === "issuesSync")?.disabled).toBe(true);
});
