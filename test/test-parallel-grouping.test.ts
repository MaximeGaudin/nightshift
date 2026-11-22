import { expect, test } from "bun:test";
import { bunVersionError, ciGroups, planGroups } from "../scripts/test-parallel";

const files = ["test/f0.test.ts", "test/f1.test.ts", "test/f2.test.ts", "test/f3.test.ts", "test/f4.test.ts", "test/f5.test.ts"];
const plan = (over: Partial<Parameters<typeof planGroups>[0]> = {}) =>
  planGroups({ files, args: [], env: {}, cores: 8, timings: {}, ...over });

test("CI grouping deals sorted files round-robin into 4 groups", () => {
  expect(plan()).toEqual({
    mode: "ci",
    filters: [],
    groups: [["test/f0.test.ts", "test/f4.test.ts"], ["test/f1.test.ts", "test/f5.test.ts"], ["test/f2.test.ts"], ["test/f3.test.ts"]],
  });
});

test("CI grouping ignores cores and timings", () => {
  const ref = plan().groups;
  for (const cores of [3, 4, 8, 10]) {
    expect(plan({ cores }).groups).toEqual(ref);
    expect(plan({ cores, timings: { "test/f0.test.ts": 99999, "test/f3.test.ts": 5 } }).groups).toEqual(ref);
  }
});

test("CI grouping sorts by code unit, whatever the input order or locale", () => {
  const input = ["test/ab.test.ts", "test/a-b.test.ts", "test/B.test.ts"];
  expect(ciGroups(input, 1)).toEqual([["test/B.test.ts", "test/a-b.test.ts", "test/ab.test.ts"]]);
  expect(ciGroups([...input].reverse(), 1)).toEqual(ciGroups(input, 1));
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
