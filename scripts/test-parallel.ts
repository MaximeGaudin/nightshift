/**
 * Runs the test suite as N parallel `bun test` processes, one group of files each, and prints one summary.
 *
 * Usage: bun scripts/test-parallel.ts [--fast] [--jobs N] [--write-timings] [path-substring ...]
 *   (default)            CI grouping: CI_JOBS groups balanced with the committed test/timings.json (longest file first
 *                        into the lightest group, files of a group in code-unit order). A pure function of the file list
 *                        and test/timings.json: same files, same order on any machine and in the CI job.
 *   --fast               fast grouping: min(cores, 8) groups balanced with .test-timings.json (not the CI's)
 *   --jobs N, TEST_JOBS=N  fast grouping with N groups
 *   --write-timings      CI grouping on every file, then, only if all groups pass, rewrites test/timings.json from the
 *                        measured durations (bun run test:timings). Refuses path filters, --fast and --jobs.
 *   test/timings.json    committed per-file durations (ms, multiples of 100), used by the CI grouping; a file without
 *                        an entry costs DEFAULT_MS
 *   .test-timings.json   per-file durations (ms) of the previous run, git-ignored, used by the fast grouping
 *
 * Files are passed as `./path`: a bare `test/a.test.ts` is a substring filter and would also run `test/a.test.tsx`.
 * Each process loads test/preload.ts (bunfig.toml), so each has its own NIGHTSHIFT_HOME and skills folder.
 * Bun 1.2.x has no native parallelism between test files; this script is the parallelism. `bun test` stays
 * available for debugging.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const TIMINGS = join(ROOT, ".test-timings.json");
const COMMITTED_TIMINGS = join(ROOT, "test", "timings.json");
const MAX_JOBS = 8;
/** Cost of a file with no committed duration: fixed, so a new test file has a predictable effect on the groups. */
export const DEFAULT_MS = 1000;
/** The hint at the end of a CI-grouping run when the slowest group is this far above the average. */
const DRIFT_RATIO = 1.25;
export const CI_JOBS = 4;

export type Timings = Record<string, number>;

/** Greedy longest-first balancing: each file goes to the group with the smallest total so far. */
export function balance(files: string[], timings: Timings, jobs: number): string[][] {
  const known = Object.values(timings).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : DEFAULT_MS;
  const cost = (f: string) => timings[f] ?? median;
  const groups = Array.from({ length: Math.max(1, Math.min(jobs, files.length)) }, () => ({ files: [] as string[], ms: 0 }));
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const g = groups.reduce((min, x) => (x.ms < min.ms ? x : min));
    g.files.push(f);
    g.ms += cost(f);
  }
  return groups.map((g) => g.files).filter((g) => g.length > 0);
}

/** Code-unit order: never `localeCompare`, whose result depends on the locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * CI grouping: greedy longest-first balancing with the committed durations. A pure function of the file list and of
 * `committed`: no core count, no .test-timings.json, no locale. Ties go to the first file in code-unit order and to the
 * lowest group; the files of each group are then sorted by code unit.
 */
export function ciGroups(files: string[], committed: Timings, jobs: number = CI_JOBS): string[][] {
  const cost = (f: string) => committed[f] ?? DEFAULT_MS;
  const groups = Array.from({ length: Math.max(1, Math.min(jobs, files.length)) }, () => ({ files: [] as string[], ms: 0 }));
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || byCodeUnit(a, b))) {
    const g = groups.reduce((min, x) => (x.ms < min.ms ? x : min));
    g.files.push(f);
    g.ms += cost(f);
  }
  return groups.map((g) => g.files.sort(byCodeUnit)).filter((g) => g.length > 0);
}

/** A duration as stored in test/timings.json: nearest 100 ms, at least 100. */
export const roundTiming = (ms: number) => Math.max(100, Math.round(ms / 100) * 100);

/** Contents of test/timings.json: one entry per file, keys in code-unit order, 2-space indent (what Biome keeps). */
export function formatTimings(timings: Timings): string {
  const sorted: Timings = {};
  for (const f of Object.keys(timings).sort(byCodeUnit)) sorted[f] = roundTiming(timings[f]);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export type Plan = { mode: "ci" | "fast"; groups: string[][]; filters: string[]; writeTimings: boolean };

/** Chooses the grouping from the arguments and the environment. Pure: main() does the I/O. */
export function planGroups(opts: {
  files: string[];
  args: string[];
  env: Record<string, string | undefined>;
  cores: number;
  /** Local durations of the previous run (.test-timings.json): the fast grouping only. */
  timings: Timings;
  /** Committed durations (test/timings.json): the CI grouping only. */
  committed: Timings;
}): Plan {
  let fast = false;
  let writeTimings = false;
  let jobs = Number(opts.env.TEST_JOBS) || 0;
  if (jobs) fast = true;
  const filters: string[] = [];
  const { args } = opts;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fast") fast = true;
    else if (args[i] === "--write-timings") writeTimings = true;
    else if (args[i] === "--jobs") {
      fast = true;
      jobs = Number(args[++i]) || jobs;
    } else if (args[i].startsWith("--jobs=")) {
      fast = true;
      jobs = Number(args[i].slice(7)) || jobs;
    } else filters.push(args[i]);
  }
  const files = filters.length ? opts.files.filter((f) => filters.some((x) => f.includes(x))) : opts.files;
  if (writeTimings && (fast || filters.length))
    throw new Error("--write-timings needs the whole suite with the CI grouping: no path filter, no --fast, no --jobs, no TEST_JOBS");
  if (!fast) return { mode: "ci", groups: ciGroups(files, opts.committed), filters, writeTimings };
  jobs = Math.max(1, Math.floor(jobs || Math.min(opts.cores, MAX_JOBS)));
  return { mode: "fast", groups: balance(files, opts.timings, jobs), filters, writeTimings };
}

/** Per-file duration (ms) and failure count from a bun junit report. */
export function parseJunit(xml: string): { file: string; ms: number; failures: number; tests: number }[] {
  const out: { file: string; ms: number; failures: number; tests: number }[] = [];
  for (const m of xml.matchAll(/<testsuite name="([^"]*)"[^>]*?tests="(\d+)"[^>]*?failures="(\d+)"[^>]*?time="([\d.]+)"/g)) {
    out.push({ file: m[1], tests: Number(m[2]), failures: Number(m[3]), ms: Math.round(Number(m[4]) * 1000) });
  }
  return out;
}

const count = (text: string, word: string) => Number(text.match(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m"))?.[1] ?? 0);

/**
 * The message to stop on when this Bun is older than package.json asks for, else null. Bun 1.2.x never ends a
 * `bun test` run when a test that timed out fails later, during another test: the check then hangs with no output.
 */
export function bunVersionError(version: string, range: string | undefined): string | null {
  if (!range || Bun.semver.satisfies(version, range)) return null;
  return `test:parallel: Bun ${version} is too old, package.json asks for ${range}. Upgrade it: bun upgrade`;
}

async function main() {
  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { engines?: { bun?: string } };
  const tooOld = bunVersionError(Bun.version, pkg.engines?.bun);
  if (tooOld) {
    console.error(tooOld);
    process.exit(1);
  }
  const all = [...new Glob("test/**/*.test.{ts,tsx}").scanSync({ cwd: ROOT })].sort(byCodeUnit);
  let timings: Timings = {};
  try {
    timings = await Bun.file(TIMINGS).json();
  } catch {}
  let committed: Timings = {};
  try {
    committed = await Bun.file(COMMITTED_TIMINGS).json();
  } catch {}

  let plan: Plan;
  try {
    plan = planGroups({ files: all, args: process.argv.slice(2), env: process.env, cores: availableParallelism(), timings, committed });
  } catch (e) {
    console.error(`test:parallel: ${(e as Error).message}`);
    process.exit(1);
  }
  const { mode, groups, filters, writeTimings } = plan;
  const files = groups.flat();
  if (files.length === 0) {
    console.error("test:parallel: no test file matches", filters.join(" "));
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), "ns-test-parallel-"));
  const start = performance.now();
  const label =
    mode === "ci" ? (filters.length ? "CI grouping of the filtered files, not the CI's" : "CI grouping") : "fast grouping, not the CI's";
  console.log(`test:parallel: ${files.length} files, ${groups.length} groups (${label})`);

  const results = await Promise.all(
    groups.map(async (group, i) => {
      const report = join(tmp, `g${i}.xml`);
      const t0 = performance.now();
      const proc = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, ...group.map((f) => `./${f}`)], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const output = `${out}${err}`;
      let suites: ReturnType<typeof parseJunit> = [];
      try {
        suites = parseJunit(await Bun.file(report).text());
      } catch {}
      const pass = count(output, "pass");
      const fail = count(output, "fail");
      const summarized = /^\s*\d+ pass\s*$/m.test(output) && suites.length > 0;
      return { i, group, code, output, suites, pass, fail, skip: count(output, "skip"), crashed: !summarized, ms: performance.now() - t0 };
    }),
  );

  const next: Timings = { ...timings };
  for (const r of results) for (const s of r.suites) next[s.file] = s.ms;
  for (const f of Object.keys(next)) if (!all.includes(f)) delete next[f];
  const tmpTimings = `${TIMINGS}.${process.pid}.tmp`;
  writeFileSync(tmpTimings, `${JSON.stringify(next, null, 1)}\n`);
  renameSync(tmpTimings, TIMINGS);
  rmSync(tmp, { recursive: true, force: true });

  const bad = results.filter((r) => r.code !== 0 || r.crashed || r.fail > 0);
  for (const r of bad) {
    console.log(
      `\n${"=".repeat(70)}\nGroup ${r.i + 1} FAILED (exit ${r.code}${r.crashed ? ", no summary: crashed?" : ""}), ${r.group.length} files\n${"=".repeat(70)}`,
    );
    console.log(r.output.trimEnd());
    console.log(`\nReplay this group alone:\n  bun test ${r.group.map((f) => `./${f}`).join(" ")}`);
  }

  if (writeTimings && bad.length === 0) {
    const measured: Timings = {};
    for (const r of results) for (const s of r.suites) measured[s.file] = s.ms;
    const fresh: Timings = {};
    for (const f of all) fresh[f] = measured[f] ?? committed[f] ?? DEFAULT_MS;
    const tmpCommitted = `${COMMITTED_TIMINGS}.${process.pid}.tmp`;
    writeFileSync(tmpCommitted, formatTimings(fresh));
    renameSync(tmpCommitted, COMMITTED_TIMINGS);
    console.log(`test:parallel: wrote ${all.length} durations to test/timings.json`);
  } else if (writeTimings) {
    console.log("test:parallel: a group failed, test/timings.json left unchanged");
  }

  const failedFiles = results.flatMap((r) => r.suites.filter((s) => s.failures > 0).map((s) => s.file));
  const crashedFiles = results.filter((r) => r.crashed).flatMap((r) => r.group);
  const total = (k: "pass" | "fail" | "skip") => results.reduce((n, r) => n + r[k], 0);
  console.log(`\n${"-".repeat(70)}`);
  for (const r of results)
    console.log(`group ${r.i + 1}: ${r.group.length} files, ${(r.ms / 1000).toFixed(1)}s${bad.includes(r) ? "  FAILED" : ""}`);
  console.log(
    `${total("pass")} pass, ${total("fail")} fail, ${total("skip")} skip, ${files.length} files, ${((performance.now() - start) / 1000).toFixed(1)}s`,
  );
  if (mode === "ci" && !filters.length && !writeTimings) {
    const unknown = all.filter((f) => !(f in committed)).length;
    if (unknown)
      console.log(
        `hint: ${unknown} test file(s) have no duration in test/timings.json (counted ${DEFAULT_MS} ms each): run bun run test:timings`,
      );
    const avg = results.reduce((n, r) => n + r.ms, 0) / results.length;
    const slowest = Math.max(...results.map((r) => r.ms));
    if (slowest > avg * DRIFT_RATIO)
      console.log(
        `hint: the slowest group took ${(slowest / 1000).toFixed(1)}s, ${Math.round((slowest / avg - 1) * 100)}% above the average (${(avg / 1000).toFixed(1)}s): test/timings.json may be stale, run bun run test:timings`,
      );
  }
  if (failedFiles.length) console.log(`Failing files:\n${failedFiles.map((f) => `  ${f}`).join("\n")}`);
  if (crashedFiles.length) console.log(`Files of crashed groups:\n${crashedFiles.map((f) => `  ${f}`).join("\n")}`);
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.main) await main();
