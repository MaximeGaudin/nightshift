/**
 * Runs the test suite as N parallel `bun test` processes, one group of files each, and prints one summary.
 *
 * Usage: bun scripts/test-parallel.ts [--jobs N] [path-substring ...]
 *   TEST_JOBS=N          number of groups (default: min(cores, 8))
 *   .test-timings.json   per-file durations (ms) of the previous run, git-ignored, used to balance the groups
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
const MAX_JOBS = 8;
const DEFAULT_MS = 1000;

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

/** Per-file duration (ms) and failure count from a bun junit report. */
export function parseJunit(xml: string): { file: string; ms: number; failures: number; tests: number }[] {
  const out: { file: string; ms: number; failures: number; tests: number }[] = [];
  for (const m of xml.matchAll(/<testsuite name="([^"]*)"[^>]*?tests="(\d+)"[^>]*?failures="(\d+)"[^>]*?time="([\d.]+)"/g)) {
    out.push({ file: m[1], tests: Number(m[2]), failures: Number(m[3]), ms: Math.round(Number(m[4]) * 1000) });
  }
  return out;
}

const count = (text: string, word: string) => Number(text.match(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m"))?.[1] ?? 0);

async function main() {
  const args = process.argv.slice(2);
  let jobs = Number(process.env.TEST_JOBS) || Math.min(availableParallelism(), MAX_JOBS);
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--jobs") jobs = Number(args[++i]) || jobs;
    else if (args[i].startsWith("--jobs=")) jobs = Number(args[i].slice(7)) || jobs;
    else filters.push(args[i]);
  }
  jobs = Math.max(1, Math.floor(jobs));

  const all = [...new Glob("test/**/*.test.{ts,tsx}").scanSync({ cwd: ROOT })].sort();
  const files = filters.length ? all.filter((f) => filters.some((x) => f.includes(x))) : all;
  if (files.length === 0) {
    console.error("test:parallel: no test file matches", filters.join(" "));
    process.exit(1);
  }
  let timings: Timings = {};
  try {
    timings = await Bun.file(TIMINGS).json();
  } catch {}

  const groups = balance(files, timings, jobs);
  const tmp = mkdtempSync(join(tmpdir(), "ns-test-parallel-"));
  const start = performance.now();
  console.log(`test:parallel: ${files.length} files, ${groups.length} groups`);

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
  if (failedFiles.length) console.log(`Failing files:\n${failedFiles.map((f) => `  ${f}`).join("\n")}`);
  if (crashedFiles.length) console.log(`Files of crashed groups:\n${crashedFiles.map((f) => `  ${f}`).join("\n")}`);
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.main) await main();
