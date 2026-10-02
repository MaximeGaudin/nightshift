import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBoard } from "../src/server/store.ts";
import { type ChildServer, removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

test("project-parallel-normalize: clamps numbers, drops anything else", () => {
  const cap = (maxParallel: unknown) => normalizeBoard({ columns: [], cards: [], maxParallel }, "x").maxParallel;
  expect(cap(0)).toBe(1);
  expect(cap(999)).toBe(32);
  expect(cap(4.7)).toBe(4);
  expect(cap("5")).toBe(5);
  for (const bad of ["abc", "", null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect("maxParallel" in normalizeBoard({ columns: [], cards: [], maxParallel: bad }, "x")).toBe(false);
  }
  expect("maxParallel" in normalizeBoard({ columns: [], cards: [] }, "x")).toBe(false);
});

/** Child server whose settings file already holds `settings` (the legacy global cap lives there). */
async function serverWithSettings(settings: object | null) {
  const home = tempDir("ns-cap-home-");
  if (settings) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  }
  const srv = await startChildServer({ env: { NIGHTSHIFT_HOME: home } });
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  return { srv, dir, home };
}

const snapshot = (srv: ChildServer, dir: string) => srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());

test("legacy-default: a board without maxParallel uses the settings file's value, else 3", async () => {
  const legacy = await serverWithSettings({ maxParallel: 2 });
  try {
    expect((await snapshot(legacy.srv, legacy.dir)).maxParallel).toBe(2);
    const settings = await legacy.srv.call("/api/settings").then((r) => r.json());
    expect("maxParallel" in settings).toBe(false);
    // Saving other settings keeps the legacy key in the file.
    expect((await legacy.srv.call("/api/settings", { method: "PUT", body: { model: "x" } })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(legacy.home, "settings.json"), "utf8")).maxParallel).toBe(2);
    // The board file is not rewritten with a cap it did not have.
    expect("maxParallel" in JSON.parse(readFileSync(join(legacy.dir, "nightshift.json"), "utf8"))).toBe(false);
  } finally {
    await legacy.srv.stop();
  }
  const fresh = await serverWithSettings(null);
  try {
    expect((await snapshot(fresh.srv, fresh.dir)).maxParallel).toBe(3);
  } finally {
    await fresh.srv.stop();
  }
});

test("settings-put-ignores-maxParallel over HTTP, unknown keys stay a 400", async () => {
  const { srv } = await serverWithSettings(null);
  try {
    const before = await srv.call("/api/settings").then((r) => r.json());
    for (const value of [5, "many"]) {
      const r = await srv.call("/api/settings", { method: "PUT", body: { maxParallel: value } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(before);
    }
    expect((await srv.call("/api/settings", { method: "PUT", body: { nope: 1 } })).status).toBe(400);
  } finally {
    await srv.stop();
  }
});

test("board-put-maxParallel: writes the project's nightshift.json, refuses non-numbers", async () => {
  const { srv, dir } = await serverWithSettings(null);
  const file = join(dir, "nightshift.json");
  try {
    const ok = await srv.call("/api/board", { method: "PUT", body: { project: dir, maxParallel: 4 } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).maxParallel).toBe(4);
    expect(JSON.parse(readFileSync(file, "utf8")).maxParallel).toBe(4);
    const before = readFileSync(file, "utf8");
    for (const bad of ["abc", null, true]) {
      const r = await srv.call("/api/board", { method: "PUT", body: { project: dir, maxParallel: bad } });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("maxParallel must be a number");
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(
      (await srv.call("/api/board", { method: "PUT", body: { project: dir, maxParallel: 0 } }).then((r) => r.json())).maxParallel,
    ).toBe(1);
    // A rename without maxParallel leaves the cap alone.
    await srv.call("/api/board", { method: "PUT", body: { project: dir, name: "Renamed" } });
    expect((await snapshot(srv, dir)).maxParallel).toBe(1);
  } finally {
    await srv.stop();
  }
});
