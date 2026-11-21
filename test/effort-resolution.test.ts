import { describe, expect, test } from "bun:test";
import {
  economicEffort,
  mergeEfforts,
  resolveEffort,
  resolveQuickEffort,
  sanitizeEfforts,
  validateEffortsStrict,
} from "../src/shared/effort.ts";
import type { Column } from "../src/shared/types.ts";

const col = (over: Partial<Column> = {}): Column => ({ id: "c", name: "C", type: "skill", skill: "nightshift-merge", ...over });
const s = (effort: "" | "inherit" | "low" | "medium" | "high" | "xhigh" | "max" = "") => ({ effort });

describe("resolveEffort", () => {
  test("card > column > settings > default", () => {
    expect(resolveEffort(col({ effort: "high" }), s("max"), { efforts: { "nightshift-merge": "xhigh" } })).toEqual({
      effort: "xhigh",
      source: "card",
    });
    expect(resolveEffort(col({ effort: "high" }), s("max"))).toEqual({ effort: "high", source: "column" });
    expect(resolveEffort(col(), s("max"))).toEqual({ effort: "max", source: "settings" });
    expect(resolveEffort(col(), s())).toEqual({ effort: "low", source: "default" });
  });
  test("economic default of each nightshift skill, medium otherwise", () => {
    const d = (skill?: string) => resolveEffort(col({ skill }), s()).effort;
    expect(d("nightshift-grill")).toBe("medium");
    expect(d("nightshift-plan")).toBe("high");
    expect(d("nightshift-implement")).toBe("medium");
    expect(d("nightshift-review")).toBe("medium");
    expect(d("nightshift-merge")).toBe("low");
    expect(d("other")).toBe("medium");
    expect(resolveEffort({ id: "x", name: "x", type: "inert" }, s()).effort).toBe("medium");
    expect(economicEffort()).toBe("medium");
  });
  test("inherit passes no effort unless card or column set one", () => {
    expect(resolveEffort(col(), s("inherit"))).toEqual({ effort: undefined, source: "settings" });
    expect(resolveEffort(col({ effort: "high" }), s("inherit"))).toEqual({ effort: "high", source: "column" });
  });
  test("settings value is trimmed before it reaches --effort", () => {
    expect(resolveEffort(col(), { effort: " high " as "high" })).toEqual({ effort: "high", source: "settings" });
  });
  test("card entry ignored in a non-skill column", () => {
    const c: Column = { id: "x", name: "x", type: "inert", skill: "nightshift-merge" };
    expect(resolveEffort(c, s(), { efforts: { "nightshift-merge": "max" } }).source).toBe("default");
  });
  test("quick run: settings then skill default", () => {
    expect(resolveQuickEffort("nightshift-merge", s("high"))).toEqual({ effort: "high", source: "settings" });
    expect(resolveQuickEffort("nightshift-merge", s())).toEqual({ effort: "low", source: "default" });
    expect(resolveQuickEffort("nightshift-merge", s("inherit")).effort).toBeUndefined();
  });
});

describe("efforts map", () => {
  test("merge adds, default removes, invalid dropped", () => {
    const a = mergeEfforts(undefined, { x: "low", y: "turbo" });
    expect(a.efforts).toEqual({ x: "low" });
    expect(a.dropped).toEqual([{ key: "y", value: "turbo" }]);
    const b = mergeEfforts(a.efforts, { x: "default" });
    expect(b.efforts).toBeUndefined();
    expect(b.changes).toEqual(["x removed"]);
  });
  test("strict validation", () => {
    expect(validateEffortsStrict({ a: "bad" }).ok).toBe(false);
    expect(validateEffortsStrict({ a: "default" }).ok).toBe(false);
    expect(validateEffortsStrict(null)).toEqual({ ok: true, efforts: undefined });
    expect(validateEffortsStrict({})).toEqual({ ok: true, efforts: undefined });
    expect(validateEffortsStrict({ a: "low" })).toEqual({ ok: true, efforts: { a: "low" } });
  });
  test("lenient sanitize", () => {
    expect(sanitizeEfforts({ a: "bad", b: "low" }).efforts).toEqual({ b: "low" });
  });
});
