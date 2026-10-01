import { expect, test } from "bun:test";
import type { ProjectSnapshot, SkillInfo } from "../src/shared/types.ts";
import { buildCommands, commandLabel, paletteFilter, quickRunInstruction } from "../src/web/commands.ts";
import { setLocale } from "../src/web/i18n/index.ts";

const columns = [
  { id: "col_a", name: "Idées", type: "inert" },
  { id: "col_done", name: "Done", type: "inert" },
];
const card = (number: number, title: string) => ({ id: `card_${number}`, number, title, description: "", columnId: "col_a" });
const snap = (extra: object = {}) =>
  ({
    path: "/p/current",
    board: { name: "b", columns, cards: [card(1, "Un"), card(12, "Douze"), card(19, "Deploiement")] },
    live: {},
    sequence: { status: "stopped" },
    ...extra,
  }) as unknown as ProjectSnapshot;
const ctx = (extra: object = {}, recentProjects = ["/p/current", "/p/other"]) => ({
  snap: snap(extra),
  recentProjects,
  skills: [] as SkillInfo[],
});

test("commands-build", () => {
  const cmds = buildCommands(ctx());
  const seq = cmds.find((c) => c.id === "sequence");
  expect(seq?.label).toBe("Lancer le mode séquentiel");
  expect(seq?.disabled).toBe(false);
  expect(buildCommands(ctx({ agentsDisabled: true })).find((c) => c.id === "sequence")?.disabled).toBe(true);
  expect(buildCommands(ctx({ lockedBy: 3 })).find((c) => c.id === "sequence")?.disabled).toBe(true);
  const active = buildCommands(ctx({ sequence: { status: "active", cardId: "card_1" } })).find((c) => c.id === "sequence");
  expect(active?.label).toBe("Mettre en pause");
  expect(active?.action).toEqual({ type: "sequence", play: false });
  expect(cmds.filter((c) => c.group === "projects").map((c) => c.action)).toEqual([{ type: "openProject", path: "/p/other" }]);
  expect(cmds.find((c) => c.id === "new-card")?.label).toBe("Créer une carte dans Idées");
  expect(cmds.filter((c) => c.group === "cards").map((c) => c.value)).toEqual(["#1 Un", "#12 Douze", "#19 Deploiement"]);
});

test("palette-filter-ref", () => {
  const cards = buildCommands(ctx()).filter((c) => c.group === "cards");
  const hits = (search: string) => cards.filter((c) => paletteFilter(c.value, search, c.keywords) > 0).map((c) => c.value);
  expect(hits("#1")).toEqual(["#1 Un"]);
  expect(hits("#12")).toEqual(["#12 Douze"]);
  expect(hits("déploi")).toEqual(["#19 Deploiement"]);
  expect(hits("DEPLOI")).toEqual(["#19 Deploiement"]);
  expect(hits("idees")).toHaveLength(3);
});

test("palette-create-free-text", () => {
  const cmds = buildCommands(ctx());
  const create = cmds.find((c) => c.id === "new-card");
  if (!create) throw new Error("missing create item");
  const shown = (search: string) => paletteFilter(create.value, search, create.keywords) > 0;
  // Arbitrary text keeps the create item, so Enter prefills the new card dialog.
  expect(shown("Refaire le logo")).toBe(true);
  expect(commandLabel(create, "  Refaire le logo ")).toBe("Créer « Refaire le logo » dans Idées");
  // Real matches rank above it.
  const card = cmds.find((c) => c.group === "cards" && c.label === "Douze");
  if (!card) throw new Error("missing card");
  expect(paletteFilter(card.value, "douze", card.keywords)).toBeGreaterThan(paletteFilter(create.value, "douze", create.keywords));
  // Empty and "#<ref>" searches: plain label, and a ref search hides it.
  expect(commandLabel(create, "")).toBe("Créer une carte dans Idées");
  expect(shown("#12")).toBe(false);
  expect(commandLabel(create, "#12")).toBe("Créer une carte dans Idées");
  // Other commands do not get the free-text fallback.
  const cols = cmds.find((c) => c.id === "open:columns");
  expect(cols && paletteFilter(cols.value, "Refaire le logo", cols.keywords)).toBe(0);
});

test("palette-follows-locale", () => {
  setLocale("en");
  try {
    const cmds = buildCommands(ctx());
    const create = cmds.find((c) => c.id === "new-card");
    expect(create?.label).toBe("Create a card in Idées");
    const cols = cmds.find((c) => c.id === "open:columns");
    expect(cols && paletteFilter(cols.value, "columns", cols.keywords)).toBe(1);
    expect(cols && paletteFilter(cols.value, "colonnes", cols.keywords)).toBe(0);
  } finally {
    setLocale("fr");
  }
});

const skillInfo = (name: string, description = `${name} desc`): SkillInfo => ({ name, description, scope: "project", path: `/s/${name}` });
const skillCtx = (extra: object = {}) => ({
  ...ctx({ ...extra, board: { name: "b", columns, cards: [], favoriteSkills: ["deploy-prod", "ghost"] } }),
  skills: [skillInfo("lint"), skillInfo("deploy-prod")],
});

test("palette-skills-group", () => {
  const cmds = buildCommands(skillCtx());
  const skills = cmds.filter((c) => c.group === "skills");
  expect(skills.map((c) => c.action)).toEqual([{ type: "quickRun", skill: "deploy-prod" }]);
  expect(skills[0]?.value).toBe("skill:deploy-prod deploy-prod desc");
  expect(skills[0]?.disabled).toBe(false);
  const order = cmds.map((c) => c.group);
  expect(order.lastIndexOf("actions")).toBeLessThan(order.indexOf("skills"));
  expect(order.indexOf("skills")).toBeLessThan(order.indexOf("navigation"));
  expect(buildCommands(skillCtx({ agentsDisabled: true })).find((c) => c.group === "skills")?.disabled).toBe(true);
  expect(buildCommands(skillCtx({ lockedBy: 2 })).find((c) => c.group === "skills")?.disabled).toBe(true);
});

test("palette-instruction", () => {
  expect(quickRunInstruction("deploy-prod", "Deploy-Prod v1.4")).toBe("v1.4");
  expect(quickRunInstruction("deploy-prod", "depl")).toBe("");
  expect(quickRunInstruction("deploy-prod", "deploy-prod")).toBe("");
  expect(quickRunInstruction("deploy-prod", "deploy-production x")).toBe("");
  const c = buildCommands(skillCtx()).find((x) => x.group === "skills");
  if (!c) throw new Error("missing skill entry");
  for (const search of ["deploy-prod v1.4", "depl", "lancer"]) expect(paletteFilter(c.value, search, c.keywords)).toBe(1);
  expect(commandLabel(c, "deploy-prod v1.4")).toContain("“v1.4”");
  expect(commandLabel(c, "depl")).toBe("deploy-prod");
});
