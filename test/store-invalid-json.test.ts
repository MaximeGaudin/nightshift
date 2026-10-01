import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/server/store.ts";
import { waitFor } from "./helpers.ts";

test("store-invalid-json: invalid file at open names the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-inv-"));
  writeFileSync(join(dir, "nightshift.json"), "{ not json");
  expect(() => new Project(dir)).toThrow(join(dir, "nightshift.json"));
});

test("store-invalid-json: invalid external edit is retried, then backed up before the next write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-inv-"));
  const file = join(dir, "nightshift.json");
  const p = new Project(dir);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    writeFileSync(file, "<<<<<<< HEAD\n{}\n=======\n");
    await waitFor(() => err.mock.calls.length >= 1);
    // Fixing the file is picked up: the failed read did not memorise the mtime.
    writeFileSync(file, JSON.stringify({ version: 1, name: "fixed", columns: [{ id: "a", name: "A", type: "inert" }], cards: [] }));
    await waitFor(() => p.board.name === "fixed");
    // A new invalid edit followed by an in-memory mutation must not lose the user's content.
    const broken = "{ conflict";
    const failures = err.mock.calls.length;
    writeFileSync(file, broken);
    await waitFor(() => err.mock.calls.length > failures);
    p.mutate(() => {});
    expect(readFileSync(`${file}.invalid`, "utf8")).toBe(broken);
    expect(existsSync(file)).toBe(true);
  } finally {
    err.mockRestore();
    p.close();
  }
});
