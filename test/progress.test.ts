import { describe, expect, test } from "bun:test";
import { parseProgressMarker, progressFromTodos } from "../src/server/progress.ts";

describe("parseProgressMarker", () => {
  test("marker-basic", () => {
    expect(parseProgressMarker("blabla\n[nightshift-progress] 3/7 Écrire les tests\n")).toEqual({
      step: 3,
      total: 7,
      label: "Écrire les tests",
    });
  });
  test("marker-crlf", () => {
    expect(parseProgressMarker("x\r\n[nightshift-progress] 1/2 A\r\n")).toEqual({ step: 1, total: 2, label: "A" });
  });
  test("marker-last-wins", () => {
    expect(parseProgressMarker("[nightshift-progress] 1/4 A\n[nightshift-progress] 2/4 B")).toEqual({
      step: 2,
      total: 4,
      label: "B",
    });
  });
  test("marker-invalid", () => {
    for (const t of [
      "[nightshift-progress] 8/7 x",
      "[nightshift-progress] 0/3 x",
      "[nightshift-progress] 3/0 x",
      "[nightshift-progress] abc/3 x",
      "[nightshift-progress] 1/1000 x",
      "texte [nightshift-progress] 1/2",
    ]) {
      expect(parseProgressMarker(t)).toBeUndefined();
    }
  });
  test("marker-invalid-ignored-keeps-previous", () => {
    expect(parseProgressMarker("[nightshift-progress] 1/2 A\n[nightshift-progress] 9/2 B")).toEqual({
      step: 1,
      total: 2,
      label: "A",
    });
  });
  test("marker-label", () => {
    expect(parseProgressMarker("[nightshift-progress] 1 / 2")).toEqual({ step: 1, total: 2, label: "" });
    expect(parseProgressMarker(`[nightshift-progress] 1/2 ${"a".repeat(300)}`)?.label).toHaveLength(120);
  });
});

describe("progressFromTodos", () => {
  test("todo-in-progress", () => {
    expect(
      progressFromTodos({
        todos: [
          { content: "A", status: "completed" },
          { content: "B", activeForm: "Codage", status: "in_progress" },
          { content: "C", status: "pending" },
        ],
      }),
    ).toEqual({ step: 2, total: 3, label: "Codage" });
  });
  test("todo-in-progress-falls-back-to-content", () => {
    expect(progressFromTodos({ todos: [{ content: "B", status: "in_progress" }] })).toEqual({
      step: 1,
      total: 1,
      label: "B",
    });
  });
  test("todo-none-in-progress", () => {
    expect(
      progressFromTodos({
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "completed" },
          { content: "C", status: "pending" },
        ],
      }),
    ).toEqual({ step: 2, total: 3, label: "B" });
    expect(
      progressFromTodos({
        todos: [
          { content: "A", status: "pending" },
          { content: "B", status: "pending" },
        ],
      }),
    ).toEqual({ step: 1, total: 2, label: "A" });
  });
  test("todo-empty-or-malformed", () => {
    expect(progressFromTodos({ todos: [] })).toBeUndefined();
    expect(progressFromTodos({})).toBeUndefined();
    expect(progressFromTodos(null)).toBeUndefined();
    expect(progressFromTodos("x")).toBeUndefined();
  });
});

describe("progress-marker-tolerant", () => {
  for (const line of [
    "`[nightshift-progress] 2/4 Build`",
    "**[nightshift-progress] 2/4 Build**",
    "- [nightshift-progress] 2/4 Build",
    "> [nightshift-progress] 2/4 Build",
    "  * [nightshift-progress] 2/4 Build",
    "1. [nightshift-progress] 2/4 Build",
    "_[nightshift-progress] 2/4 Build_",
  ]) {
    test(line, () => {
      expect(parseProgressMarker(line)).toEqual({ step: 2, total: 4, label: "Build" });
    });
  }
});

describe("progress-marker-rejects-prose", () => {
  test("mid-sentence", () => {
    expect(parseProgressMarker("Write a line [nightshift-progress] 2/4 x in your reply")).toBeUndefined();
  });
});
