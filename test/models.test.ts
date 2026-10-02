import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBoard, Project } from "../src/server/store.ts";
import {
  describeModelChanges,
  diffModels,
  formatDropped,
  isValidModelValue,
  mergeModels,
  resolveModel,
  sanitizeModels,
  validateModelsStrict,
} from "../src/shared/models.ts";
import type { Column } from "../src/shared/types.ts";
import { tempDir } from "./helpers.ts";

const col = (extra: Partial<Column> = {}): Column => ({ id: "c", name: "C", type: "skill", skill: "s", ...extra });
const set = (model: string) => ({ model });

test("resolveModel priority and source", () => {
  const card = { models: { s: "haiku" } };
  expect(resolveModel(col({ model: "opus" }), set("sonnet"), card)).toEqual({ model: "haiku", source: "card" });
  expect(resolveModel(col({ model: "opus" }), set("sonnet"))).toEqual({ model: "opus", source: "column" });
  expect(resolveModel(col(), set(" sonnet "))).toEqual({ model: "sonnet", source: "settings" });
  expect(resolveModel(col(), set(""))).toEqual({ model: undefined, source: "default" });
  expect(resolveModel(col({ model: "  " }), set("  "), { models: { s: "  " } })).toEqual({ model: undefined, source: "default" });
  expect(resolveModel(col(), set("x"), { models: { s: " haiku " } }).model).toBe("haiku");
});

test("resolveModel lockModel", () => {
  const card = { models: { s: "haiku" } };
  expect(resolveModel(col({ model: "opus", lockModel: true }), set("sonnet"), card)).toEqual({ model: "opus", source: "column" });
  expect(resolveModel(col({ lockModel: true }), set("sonnet"), card)).toEqual({ model: "sonnet", source: "settings" });
});

test("resolveModel inert column ignores card.models", () => {
  const inert: Column = { id: "i", name: "I", type: "inert", skill: "s" };
  expect(resolveModel(inert, set("sonnet"), { models: { s: "haiku" } }).source).toBe("settings");
});

test("isValidModelValue", () => {
  for (const v of ["opus", " fable ", "claude-opus-4-5", "claude-opus-4-5[1m]"]) expect(isValidModelValue(v)).toBe(true);
  for (const v of ["default", "Opus", "gpt-4", "", "opus --x", "claude-"]) expect(isValidModelValue(v)).toBe(false);
});

test("mergeModels applies, removes, reports changes", () => {
  const r = mergeModels({ a: "opus" }, { b: "haiku", a: "default" });
  expect(r.models).toEqual({ b: "haiku" });
  expect(r.changes).toEqual(["b=haiku", "a removed"]);
  expect(r.dropped).toEqual([]);
});

test("mergeModels no-ops", () => {
  expect(mergeModels({ a: "opus" }, { a: "opus" }).changes).toEqual([]);
  expect(mergeModels(undefined, { a: "default" })).toEqual({ models: undefined, changes: [], dropped: [] });
  const cur = { a: "opus" };
  expect(mergeModels(cur, "x").models).toBe(cur);
  expect(mergeModels(cur, ["a"]).changes).toEqual([]);
  expect(mergeModels(cur, null).models).toBe(cur);
  expect(mergeModels({ a: "opus" }, { a: "default" }).models).toBeUndefined();
});

test("mergeModels drops invalid entries, applies valid siblings", () => {
  const r = mergeModels(undefined, {
    a: "opus --dangerously-skip-permissions",
    b: "Opus",
    c: "gpt-4",
    "Bad Key": "opus",
    d: 42,
    e: "sonnet",
    f: "claude-opus-4-5[1m]",
  });
  expect(r.models).toEqual({ e: "sonnet", f: "claude-opus-4-5[1m]" });
  expect(r.dropped.map((d) => d.key)).toEqual(["a", "b", "c", "Bad Key", "d"]);
  expect(r.dropped[4]).toEqual({ key: "d", value: "42" });
});

test("validateModelsStrict", () => {
  expect(validateModelsStrict(null)).toEqual({ ok: true, models: undefined });
  expect(validateModelsStrict({})).toEqual({ ok: true, models: undefined });
  expect(validateModelsStrict({ "nightshift-implement": " opus " })).toEqual({ ok: true, models: { "nightshift-implement": "opus" } });
  const bad = validateModelsStrict({ ok: "opus", "nightshift-implement": "x" });
  expect(bad).toEqual({ ok: false, error: 'Invalid model "x" for nightshift-implement' });
  for (const v of ["default", 3, "Opus"]) expect(validateModelsStrict({ a: v }).ok).toBe(false);
  expect(validateModelsStrict({ "Bad Key": "opus" }).ok).toBe(false);
  expect(validateModelsStrict("opus").ok).toBe(false);
  expect(validateModelsStrict(["opus"]).ok).toBe(false);
});

test("sanitizeModels", () => {
  expect(sanitizeModels("x").models).toBeUndefined();
  expect(sanitizeModels({}).models).toBeUndefined();
  const r = sanitizeModels({ a: " opus ", b: "default", c: 1, "X y": "opus" });
  expect(r.models).toEqual({ a: "opus" });
  expect(r.dropped.length).toBe(3);
});

test("describe, diff, format", () => {
  expect(describeModelChanges(["a=haiku", "b removed"], "agent")).toBe("Models: a=haiku, b removed (by agent)");
  expect(diffModels({ b: "opus", a: "x" }, { b: "haiku", c: "opus" })).toEqual(["a removed", "b=haiku", "c=opus"]);
  expect(diffModels({ a: "opus" }, { a: "opus" })).toEqual([]);
  expect(formatDropped({ key: "k", value: "v" })).toBe('Ignored model "v" for k (invalid)');
  expect(formatDropped({ key: "k".repeat(100), value: "v".repeat(100) })).toBe(
    `Ignored model "${"v".repeat(80)}" for ${"k".repeat(80)} (invalid)`,
  );
});

const board = (columns: unknown[], cards: unknown[]) => ({ version: 1, name: "t", columns, cards });

test("store: models and lockModel round-trip, invalid removed, unknown preserved", () => {
  const dir = tempDir("ns-models-");
  const raw = board(
    [
      { id: "col_backlog", name: "Backlog", type: "inert", lockModel: true, model: "opus" },
      { id: "k", name: "K", type: "skill", skill: "s", model: "opus", lockModel: true },
      { id: "k2", name: "K2", type: "skill", skill: "s2", lockModel: false },
      { id: "i", name: "I", type: "inert", lockModel: true },
      { id: "col_done", name: "Done", type: "inert", lockModel: true },
    ],
    [
      {
        id: "a",
        title: "A",
        columnId: "k",
        models: { s: " haiku ", bad: "gpt-4", "Bad Key": "opus", d: "default" },
        futureField: { x: 1 },
      },
      { id: "b", title: "B", columnId: "k", models: {} },
      { id: "c", title: "C", columnId: "k", models: "nope" },
    ],
  );
  writeFileSync(join(dir, "nightshift.json"), JSON.stringify(raw));
  const p = new Project(dir);
  const b = p.board;
  const byId = (id: string) => b.columns.find((c) => c.id === id);
  expect(byId("k")?.lockModel).toBe(true);
  expect(byId("k2") && "lockModel" in (byId("k2") as object)).toBe(false);
  for (const id of ["col_backlog", "i", "col_done"]) expect("lockModel" in (byId(id) as object)).toBe(false);
  expect(b.cards[0].models).toEqual({ s: "haiku" });
  expect((b.cards[0] as unknown as Record<string, unknown>).futureField).toEqual({ x: 1 });
  expect("models" in b.cards[1]).toBe(false);
  expect("models" in b.cards[2]).toBe(false);
  // normalizing again is stable
  expect(normalizeBoard(JSON.parse(JSON.stringify(b)), "t")).toEqual(b);
  expect(existsSync(join(dir, "nightshift.json"))).toBe(true);
  expect(readFileSync(join(dir, "nightshift.json"), "utf8")).toContain("lockModel");
});
