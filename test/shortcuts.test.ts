import { expect, test } from "bun:test";
import { shortcutFor } from "../src/web/shortcuts.ts";

const key = (k: string, extra: object = {}, target: unknown = { tagName: "BODY" }) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target,
  ...extra,
});
const free = { dialogOpen: false };

test("shortcuts-ignore-fields", () => {
  for (const target of [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "DIV", getAttribute: () => "true" },
    { tagName: "SPAN", closest: () => ({}) },
  ]) {
    expect(shortcutFor(key("c", {}, target), free)).toBeNull();
    expect(shortcutFor(key("?", {}, target), free)).toBeNull();
    expect(shortcutFor(key("k", { ctrlKey: true }, target), free)).toBeNull();
  }
});

test("shortcuts-map", () => {
  expect(shortcutFor(key("k", { ctrlKey: true }), free)).toBe("palette");
  expect(shortcutFor(key("k", { metaKey: true }), free)).toBe("palette");
  expect(shortcutFor(key("c"), free)).toBe("newCard");
  expect(shortcutFor(key("C"), free)).toBe("newCard");
  expect(shortcutFor(key("?"), free)).toBe("help");
  expect(shortcutFor(key("c", { metaKey: true }), free)).toBeNull();
  expect(shortcutFor(key("c", { ctrlKey: true }), free)).toBeNull();
  expect(shortcutFor(key("c", { altKey: true }), free)).toBeNull();
  expect(shortcutFor(key("Escape"), free)).toBeNull();
  for (const e of [key("k", { ctrlKey: true }), key("c"), key("?")]) expect(shortcutFor(e, { dialogOpen: true })).toBeNull();
});
