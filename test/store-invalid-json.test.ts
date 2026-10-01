import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../src/server/store.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

test("store-invalid-json: invalid file at open names the file", () => {
  const dir = tempDir("ns-inv-");
  writeFileSync(join(dir, "nightshift.json"), "{ not json");
  expect(() => new Project(dir)).toThrow(join(dir, "nightshift.json"));
});

test("store-invalid-json: invalid external edit is retried, then backed up before the next write", async () => {
  const dir = tempDir("ns-inv-");
  const file = join(dir, "nightshift.json");
  const p = new Project(dir);
  const err = spyOn(console, "error").mockImplementation(() => {});
  // Other tests in this process may log errors too: only count the store's own.
  // Filesystem timestamps are coarse: give every external edit a distinct mtime so the watcher sees a change.
  let tick = Date.now();
  const edit = (content: string) => {
    writeFileSync(file, content);
    tick += 10000;
    utimesSync(file, new Date(tick), new Date(tick));
  };
  // fs.watch arms asynchronously and may miss an edit made right after open: re-apply the edit until it is noticed.
  const editUntil = (content: string, done: () => boolean) =>
    waitFor(() => {
      if (!done()) edit(content);
      return done();
    });
  const failures = () => err.mock.calls.filter((c) => String(c[0]).includes("nightshift.json invalide")).length;
  try {
    await editUntil("<<<<<<< HEAD\n{}\n=======\n", () => failures() >= 1);
    // Fixing the file is picked up: the failed read did not memorise the mtime.
    const fixed = JSON.stringify({ version: 1, name: "fixed", columns: [{ id: "a", name: "A", type: "inert" }], cards: [] });
    await editUntil(fixed, () => p.board.name === "fixed");
    // A new invalid edit followed by an in-memory mutation must not lose the user's content.
    const broken = "{ conflict";
    const before = failures();
    await editUntil(broken, () => failures() > before);
    p.mutate(() => {});
    expect(readFileSync(`${file}.invalid`, "utf8")).toBe(broken);
    expect(existsSync(file)).toBe(true);
  } finally {
    err.mockRestore();
    p.close();
  }
});

afterAll(removeTempDirs);
