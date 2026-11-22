import { expect, test } from "bun:test";
import { bunVersionError, ciGroups, DEFAULT_MS, formatTimings, planGroups, roundTiming, type Timings } from "../scripts/test-parallel";
import committed from "./timings.json";

const files = ["test/f0.test.ts", "test/f1.test.ts", "test/f2.test.ts", "test/f3.test.ts", "test/f4.test.ts", "test/f5.test.ts"];
const plan = (over: Partial<Parameters<typeof planGroups>[0]> = {}) =>
  planGroups({ files, args: [], env: {}, cores: 8, timings: {}, committed: {}, ...over });

const span = (groups: string[][], t: Timings) => groups.map((g) => g.reduce((n, f) => n + (t[f] ?? DEFAULT_MS), 0));

test("CI grouping balances by committed duration, longest first", () => {
  const t = {
    "test/f0.test.ts": 5000,
    "test/f1.test.ts": 3000,
    "test/f2.test.ts": 2000,
    "test/f3.test.ts": 2000,
    "test/f4.test.ts": 1000,
    "test/f5.test.ts": 1000,
  };
  expect(plan({ committed: t })).toEqual({
    mode: "ci",
    filters: [],
    writeTimings: false,
    groups: [["test/f0.test.ts"], ["test/f1.test.ts"], ["test/f2.test.ts", "test/f4.test.ts"], ["test/f3.test.ts", "test/f5.test.ts"]],
  });
});

test("CI grouping without durations deals equal files to the lowest group, files of a group in code-unit order", () => {
  expect(plan().groups).toEqual([
    ["test/f0.test.ts", "test/f4.test.ts"],
    ["test/f1.test.ts", "test/f5.test.ts"],
    ["test/f2.test.ts"],
    ["test/f3.test.ts"],
  ]);
});

test("CI grouping ignores cores and .test-timings.json", () => {
  const ref = plan({ committed }).groups;
  for (const cores of [3, 4, 8, 10]) {
    expect(plan({ cores, committed }).groups).toEqual(ref);
    expect(plan({ cores, committed, timings: { "test/f0.test.ts": 99999, "test/f3.test.ts": 5 } }).groups).toEqual(ref);
  }
  const real = Object.keys(committed);
  const groups = planGroups({ files: real, args: [], env: {}, cores: 2, timings: {}, committed }).groups;
  expect(planGroups({ files: real, args: [], env: {}, cores: 16, timings: { [real[0]]: 123456 }, committed }).groups).toEqual(groups);
});

test("CI grouping does not depend on the order of the input list, and each group is in code-unit order", () => {
  const files = Object.keys(committed);
  const ref = ciGroups(files, committed);
  expect(ciGroups([...files].reverse(), committed)).toEqual(ref);
  expect(ciGroups([...files.slice(7), ...files.slice(0, 7)], committed)).toEqual(ref);
  for (const g of ref) expect(g).toEqual([...g].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  expect(ref.flat().sort()).toEqual([...files].sort());
});

test("a file with no committed duration costs exactly DEFAULT_MS", () => {
  const known = {
    "test/f0.test.ts": 4000,
    "test/f1.test.ts": 3000,
    "test/f2.test.ts": 2000,
    "test/f3.test.ts": 1500,
    "test/f4.test.ts": 700,
  };
  expect(ciGroups(files, known)).toEqual(ciGroups(files, { ...known, "test/f5.test.ts": DEFAULT_MS }));
  expect(DEFAULT_MS).toBe(1000);
});

test("committed durations: the slowest of the 4 CI groups is at most 15% above the average", () => {
  expect(Object.keys(committed).length).toBeGreaterThan(100);
  const groups = ciGroups(Object.keys(committed), committed);
  expect(groups).toHaveLength(4);
  const spans = span(groups, committed);
  const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
  expect(Math.max(...spans)).toBeLessThanOrEqual(avg * 1.15);
});

test("committed durations are rounded, positive and in the committed format", async () => {
  for (const ms of Object.values(committed)) {
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(ms % 100).toBe(0);
  }
  expect(formatTimings(committed)).toBe(await Bun.file(`${import.meta.dir}/timings.json`).text());
});

test("roundTiming and formatTimings", () => {
  expect(roundTiming(3)).toBe(100);
  expect(roundTiming(149)).toBe(100);
  expect(roundTiming(150)).toBe(200);
  expect(roundTiming(21971)).toBe(22000);
  expect(formatTimings({ "test/b.test.ts": 1234, "test/B.test.ts": 40 })).toBe(
    '{\n  "test/B.test.ts": 100,\n  "test/b.test.ts": 1200\n}\n',
  );
});

test("--write-timings needs the whole suite with the CI grouping", () => {
  expect(plan({ args: ["--write-timings"] })).toMatchObject({ mode: "ci", writeTimings: true });
  expect(() => plan({ args: ["--write-timings", "f1"] })).toThrow("--write-timings");
  expect(() => plan({ args: ["--write-timings", "--fast"] })).toThrow("--write-timings");
  expect(() => plan({ args: ["--jobs", "2", "--write-timings"] })).toThrow("--write-timings");
  expect(() => plan({ env: { TEST_JOBS: "2" }, args: ["--write-timings"] })).toThrow("--write-timings");
});

test("--fast, --jobs and TEST_JOBS select the fast grouping", () => {
  expect(plan({ args: ["--fast"], cores: 2 })).toMatchObject({ mode: "fast" });
  expect(plan({ args: ["--fast"], cores: 2 }).groups).toHaveLength(2);
  expect(plan({ args: ["--jobs", "3"] }).groups).toHaveLength(3);
  expect(plan({ args: ["--jobs=2"] }).groups).toHaveLength(2);
  expect(plan({ env: { TEST_JOBS: "2" } })).toMatchObject({ mode: "fast" });
});

test("fast grouping balances with the timings", () => {
  const { groups } = plan({
    args: ["--jobs", "2"],
    timings: {
      "test/f0.test.ts": 100,
      "test/f1.test.ts": 1,
      "test/f2.test.ts": 1,
      "test/f3.test.ts": 1,
      "test/f4.test.ts": 1,
      "test/f5.test.ts": 1,
    },
  });
  expect(groups.find((g) => g.includes("test/f0.test.ts"))).toEqual(["test/f0.test.ts"]);
});

test("path filters apply before grouping", () => {
  const p = plan({ args: ["f1", "f2"] });
  expect(p.filters).toEqual(["f1", "f2"]);
  expect(p.groups).toEqual([["test/f1.test.ts"], ["test/f2.test.ts"]]);
});

test("a Bun older than package.json asks for stops the run with the upgrade command", () => {
  expect(bunVersionError("1.2.15", ">=1.4.2")).toBe(
    "test:parallel: Bun 1.2.15 is too old, package.json asks for >=1.4.2. Upgrade it: bun upgrade",
  );
  expect(bunVersionError("1.4.2", ">=1.4.2")).toBeNull();
  expect(bunVersionError("1.5.0", ">=1.4.2")).toBeNull();
  expect(bunVersionError("1.2.15", undefined)).toBeNull();
});

test("the tests run without the variables that make bun test print its short agent report", () => {
  for (const k of ["CLAUDECODE", "AGENT", "REPL_ID"]) expect(process.env[k]).toBeUndefined();
});
