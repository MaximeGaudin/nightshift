import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBoard, normalizeBoard } from "../src/server/store.ts";
import type { Card } from "../src/shared/types.ts";
import { type ChildServer, startChildServer } from "./helpers.ts";

const cardWith = (id: string, seenDescription: unknown) => ({
  id,
  number: 1,
  title: "t",
  description: "d",
  columnId: "col_backlog",
  history: [],
  seenDescription,
});

test("store-seen-description: a valid snapshot survives a reload, an invalid one is dropped", () => {
  const raw = {
    ...defaultBoard("x"),
    cards: [
      cardWith("ok", { sessionId: "s1", text: "## A\n\nbody" }),
      cardWith("no-session", { sessionId: "", text: "x" }),
      cardWith("no-text", { sessionId: "s1" }),
      cardWith("not-object", "nope"),
    ],
  };
  const board = normalizeBoard(raw, "x");
  const seen = Object.fromEntries(board.cards.map((c) => [c.id, c.seenDescription]));
  expect(seen).toEqual({
    ok: { sessionId: "s1", text: "## A\n\nbody" },
    "no-session": undefined,
    "no-text": undefined,
    "not-object": undefined,
  });
  // Known key: never kept a second time as an unknown field.
  expect(board.cards.every((c) => !("seenDescription" in c) || c.id === "ok")).toBe(true);
  expect(normalizeBoard(JSON.parse(JSON.stringify(board)), "x")).toEqual(board);
});

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer();
});
afterAll(() => srv.stop());

test("store-seen-description: the snapshot sent to the client leaves it out, the board file keeps it", async () => {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  const file = join(dir, "nightshift.json");
  const board = { ...defaultBoard("x"), cards: [cardWith("k", { sessionId: "s1", text: "seen" })], nextCardNumber: 2 };
  writeFileSync(file, JSON.stringify(board, null, 2));
  const snap = await srv.call("/api/projects/open", { body: { path: dir } }).then((r) => r.json());
  const card = (snap.board.cards as Card[]).find((c) => c.id === "k");
  expect(card?.title).toBe("t");
  expect(card && "seenDescription" in card).toBe(false);
  // A board change rewrites the file: the snapshot is still there.
  await srv.call("/api/cards/k", { method: "PATCH", body: { project: dir, title: "t2" } });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.cards[0].seenDescription).toEqual({ sessionId: "s1", text: "seen" });
  expect(saved.cards[0].title).toBe("t2");
});
