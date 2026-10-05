import { expect, test } from "bun:test";
import type { Card } from "../src/shared/types.ts";
import {
  addTab,
  closeTab,
  loadTabs,
  questionCount,
  renameTab,
  saveTabs,
  type TabStorage,
  tabLabel,
  waitingCount,
} from "../src/web/projectTabs.ts";

const memory = (): TabStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

test("project-tabs: add is idempotent", () => {
  const one = ["/a"];
  expect(addTab(one, "/a")).toBe(one);
  expect(addTab(one, "/b")).toEqual(["/a", "/b"]);
});

test("project-tabs: close picks left neighbour", () => {
  expect(closeTab(["/a", "/b", "/c"], "/b", "/b")).toEqual({ tabs: ["/a", "/c"], next: "/a" });
  expect(closeTab(["/a", "/b"], "/a", "/a")).toEqual({ tabs: ["/b"], next: "/b" });
  expect(closeTab(["/a"], "/a", "/a")).toEqual({ tabs: [], next: null });
  expect(closeTab(["/a", "/b", "/c"], "/c", "/a")).toEqual({ tabs: ["/a", "/b"], next: "/a" });
});

test("project-tabs: storage round trip and garbage", () => {
  const s = memory();
  saveTabs(s, ["/a", "/b"]);
  expect(loadTabs(s)).toEqual(["/a", "/b"]);
  s.setItem("nightshift.tabs", "{oops");
  expect(loadTabs(s)).toEqual([]);
  s.setItem("nightshift.tabs", JSON.stringify([1, "/a", "/a", ""]));
  expect(loadTabs(s)).toEqual(["/a"]);
  const broken: TabStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadTabs(broken)).toEqual([]);
  expect(() => saveTabs(broken, ["/a"])).not.toThrow();
  expect(loadTabs(undefined)).toEqual([]);
});

test("project-tabs: rename keeps order and never duplicates", () => {
  expect(renameTab(["/a", "~/b", "/c"], "~/b", "/home/b")).toEqual(["/a", "/home/b", "/c"]);
  expect(renameTab(["/a", "~/a"], "~/a", "/a")).toEqual(["/a"]);
  expect(renameTab(["/a"], "/x", "/y")).toEqual(["/a", "/y"]);
});

test("project-tabs: label is the folder name", () => {
  expect(tabLabel("/Users/me/Code/Nightshift")).toBe("Nightshift");
  expect(tabLabel("/tmp/p/")).toBe("p");
});

test("project-tabs: questionCount", () => {
  const at = "2026-10-02T09:00:00.000Z";
  const card = (id: string, columnId: string, runColumn: string): Card => ({
    id,
    number: 1,
    title: id,
    description: "",
    columnId,
    createdAt: at,
    updatedAt: at,
    enteredColumnAt: at,
    history: [],
    lastRun: { columnId: runColumn, status: "question", at, questions: ["?"] },
  });
  const cards = [card("asks", "c1", "c1"), card("live", "c1", "c1"), card("moved", "c2", "c1")];
  const board = { version: 1 as const, name: "P", columns: [], cards, nextCardNumber: 4 };
  expect(questionCount({ board, live: { live: "running" } })).toBe(1);
});

test("project-tabs: waitingCount", () => {
  const at = "2026-10-02T09:00:00.000Z";
  const card = (id: string, columnId: string): Card => ({
    id,
    number: 1,
    title: id,
    description: "",
    columnId,
    createdAt: at,
    updatedAt: at,
    enteredColumnAt: at,
    history: [],
  });
  const columns = [
    { id: "col_backlog", name: "Backlog", type: "inert" as const },
    { id: "work", name: "Work", type: "skill" as const, skill: "x" },
    { id: "test", name: "To Test", type: "inert" as const },
    { id: "col_done", name: "Done", type: "inert" as const },
  ];
  const cards = [card("b", "col_backlog"), card("w", "work"), card("t", "test"), card("d", "col_done"), card("live", "test")];
  const board = { version: 1 as const, name: "P", columns, cards, nextCardNumber: 6 };
  expect(waitingCount({ board, live: { live: "running" } })).toBe(1);
});
