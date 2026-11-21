// Deterministic merge tried before the nightshift-merge agent. The skill stays the reference of the behaviour:
// this module only covers the mechanical path and falls back to the agent on anything unexpected.

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Column } from "../shared/types.ts";
import { git, gitLine } from "./git.ts";

/** What the fast path needs from `## Result`, written by nightshift-implement. */
export type ResultFields =
  | { worktree: "none"; base: string; baseSha?: string; commits: string[] }
  | { worktree: string; base: string; baseSha?: string; commits: string[] };

const SHA = /\b[0-9a-f]{7,40}\b/g;

/** Body of a `## <heading>` section, or undefined when the note has none. */
function section(description: string, heading: string): string | undefined {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Value of a `- Key: value` line, without backticks; undefined when the line is missing. */
function field(body: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1].replace(/`/g, "").trim() : undefined;
}

/**
 * Reads Worktree, Base and Commits from `## Result`. Any doubt gives `{ missing }`: the fast path never guesses
 * a branch. A note that already has `## Merge` is a retry, left to the agent.
 */
export function parseResultFields(description: string): ResultFields | { missing: string } {
  if (section(description, "Merge") !== undefined) return { missing: "the note already has a ## Merge section (retry)" };
  const body = section(description, "Result");
  if (body === undefined) return { missing: "no ## Result section" };
  const worktreeRaw = field(body, "Worktree");
  if (!worktreeRaw) return { missing: "no Worktree line under ## Result" };
  const baseRaw = field(body, "Base");
  if (!baseRaw) return { missing: "no Base line under ## Result" };
  const base = baseRaw.split(/\s+/)[0];
  if (!base || base === "detached" || base.startsWith("nightshift/") || !/^[\w./-]+$/.test(base) || base.startsWith("-")) {
    return { missing: `unusable Base: ${baseRaw}` };
  }
  const shaMatch = baseRaw.match(/\bat\s+([0-9a-f]{7,40})\b/);
  const commits = (field(body, "Commits") ?? "").match(SHA) ?? [];
  const none = /^none\b/i.test(worktreeRaw);
  if (none && commits.length === 0) return { missing: "Worktree: none without a Commits line" };
  return {
    worktree: none ? "none" : worktreeRaw.split(/\s+/)[0],
    base,
    ...(shaMatch ? { baseSha: shaMatch[1] } : {}),
    commits,
  };
}

// ---- the deterministic merge ------------------------------------------------

export const LOCK_DIR = "nightshift-merge.lock";
export const LOCK_STALE_MS = 30 * 60_000;
/** Retries after the first attempt when another card holds the lock (the skill's "retry 5 times"). */
export const LOCK_RETRIES = 5;
export const LOCK_WAIT_MS = 2000;
export const TEST_TIMEOUT_MS = 15 * 60_000;
export const TEST_TAIL_LINES = 50;
const KILL_GRACE_MS = 5000;

export interface FastMergeInput {
  projectPath: string;
  cardId: string;
  description: string;
  column: Column;
  /** Orchestrator.stopTest bound to the card. */
  stopTest: () => void;
  isCancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  testTimeoutMs?: number;
}

export type FastMergeOutcome =
  | { kind: "merged"; summary: string; merge: string }
  | { kind: "busy"; summary: string; merge: string; owner: string }
  | { kind: "fallback"; step: string; command: string; error: string; state: string; merge?: string }
  | { kind: "cancelled" };

const NOTHING_CHANGED = "nothing changed: the base, the card branch and the worktree are as before";

class Fallback extends Error {
  constructor(
    readonly step: string,
    readonly command: string,
    readonly detail: string,
    readonly state: string = NOTHING_CHANGED,
    readonly merge?: string,
  ) {
    super(`${step}: ${detail}`);
  }
}

class Cancelled extends Error {}

const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    out.push({ path, ...(branch ? { branch } : {}) });
  }
  return out;
}

/** Processes whose command line names the worktree directory, except this server and its ancestors. */
async function worktreeProcesses(dirName: string): Promise<number[]> {
  const r = await new Promise<string>((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? ""));
  });
  const parent = new Map<number, number>();
  const matches: number[] = [];
  const needle = `/${dirName}/`;
  for (const line of r.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    parent.set(pid, Number(m[2]));
    if (`${m[3]}/`.includes(needle)) matches.push(pid);
  }
  const mine = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && pid > 1 && !mine.has(pid); pid = parent.get(pid)) mine.add(pid);
  return matches.filter((pid) => !mine.has(pid));
}

/** Runs the column's test command in its own process group; the whole group is killed when it ends. */
function runTestCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const proc = spawn("sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {}
    };
    const keep = (d: Buffer | string) => {
      output += d;
      if (output.length > 256_000) output = output.slice(-128_000);
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    // A cancelled job stops the whole test group.
    const poll = setInterval(() => {
      if (isCancelled()) killGroup();
    }, 200);
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      killGroup();
      // Let the pipes drain; a leftover child holding them cannot block the merge.
      setTimeout(() => resolve({ code, output, timedOut }), 100);
    };
    proc.on("error", (e) => {
      keep(e.message);
      done(127);
    });
    proc.on("exit", (code) => done(code));
  });
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Tries the merge of the card without an agent. Every unexpected situation returns a `fallback` outcome that
 * leaves no merge in progress and the lock released; the orchestrator then starts the agent.
 */
export async function tryFastMerge(input: FastMergeInput): Promise<FastMergeOutcome> {
  const fields = parseResultFields(input.description);
  if ("missing" in fields) return { kind: "fallback", step: "read-result", command: "", error: fields.missing, state: NOTHING_CHANGED };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = input.now ?? (() => new Date());
  const cwd = input.projectPath;
  const cardBranch = `nightshift/${input.cardId}`;
  const base = fields.base;
  const notes: string[] = [];
  let lockPath: string | undefined;
  let tempBase: string | undefined;

  const check = () => {
    if (input.isCancelled()) throw new Cancelled();
  };
  /** Runs git and turns a failure into a fallback of `step`. */
  const run = async (step: string, dir: string, args: string[], state?: string) => {
    const r = await git(dir, args);
    if (r.code !== 0) throw new Fallback(step, gitLine(dir, args), oneLine(`${r.stderr}\n${r.stdout}`, 2000) || `exit ${r.code}`, state);
    return r.stdout.trim();
  };
  const ok = async (dir: string, args: string[]) => (await git(dir, args)).code === 0;

  try {
    await run("read-result", cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]);

    // Lock, with the skill's rules.
    const common = await run("lock", cwd, ["rev-parse", "--git-common-dir"]);
    const path = resolve(cwd, common, LOCK_DIR);
    for (let attempt = 0, staleRemoved = 0; ; ) {
      try {
        mkdirSync(path);
        lockPath = path;
        writeFileSync(join(path, "owner"), `${input.cardId} ${now().toISOString()}\n`);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Fallback("lock", `mkdir ${path}`, (e as Error).message);
      }
      let owner = "";
      try {
        owner = readFileSync(join(path, "owner"), "utf8").trim();
      } catch {}
      const [who, at] = owner.split(/\s+/);
      const since = Date.parse(at ?? "");
      const stale = !owner || who === input.cardId || !Number.isFinite(since) || now().getTime() - since > LOCK_STALE_MS;
      if (stale && staleRemoved < 3) {
        rmSync(path, { recursive: true, force: true });
        notes.push(`- removed stale lock: ${owner || "(no owner)"}`);
        staleRemoved++;
        continue;
      }
      if (attempt >= LOCK_RETRIES) {
        const merge = [...notes, `- the target is busy: lock held by ${owner}`].join("\n");
        return { kind: "busy", summary: `merge rapide : la cible est occupée (verrou tenu par ${owner})`, merge, owner };
      }
      attempt++;
      await sleep(LOCK_WAIT_MS);
      check();
    }
    check();

    // The card's worktree, found by its branch (the Result path may differ by a /private prefix).
    let worktree: string | undefined;
    if (fields.worktree !== "none") {
      const list = parseWorktrees(await run("check-card", cwd, ["worktree", "list", "--porcelain"]));
      worktree = list.find((w) => w.branch === cardBranch)?.path;
      if (!worktree) throw new Fallback("check-card", gitLine(cwd, ["worktree", "list", "--porcelain"]), `no worktree on ${cardBranch}`);
    }

    // Stop the card's test environment.
    input.stopTest();
    let stopped: number[] = [];
    if (worktree) {
      stopped = await worktreeProcesses(basename(worktree));
      for (const pid of stopped) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      const deadline = Date.now() + KILL_GRACE_MS;
      while (stopped.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      for (const pid of stopped.filter(isAlive)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
      const survivors = stopped.filter(isAlive);
      if (survivors.length > 0)
        throw new Fallback("stop-test", `kill -9 ${survivors.join(" ")}`, `processes still alive: ${survivors.join(", ")}`);
    }
    const testLine = `- Test environment: ${stopped.length > 0 ? `stopped ${stopped.join(", ")}` : "none running"}`;
    check();

    // Where the base is checked out; a temporary worktree when nowhere. Only created when needed.
    let baseCheckout: string | undefined;
    const getBaseCheckout = async () => {
      if (baseCheckout) return baseCheckout;
      const list = parseWorktrees(await run("base-checkout", cwd, ["worktree", "list", "--porcelain"]));
      baseCheckout = list.find((w) => w.branch === base)?.path;
      if (!baseCheckout) {
        const dir = mkdtempSync(join(tmpdir(), "nightshift-merge-"));
        await run("base-checkout", cwd, ["worktree", "add", dir, base]);
        tempBase = dir;
        baseCheckout = dir;
      }
      const args = ["status", "--porcelain", "--untracked-files=no"];
      const dirty = await run("base-checkout", baseCheckout, args);
      if (dirty)
        throw new Fallback("base-checkout", gitLine(baseCheckout, args), `the checkout of ${base} has uncommitted changes:\n${dirty}`);
      return baseCheckout;
    };

    if (worktree) {
      const diffArgs = ["diff", "--name-only", `${base}...${cardBranch}`, "--", "nightshift.json"];
      if (await run("check-card", cwd, diffArgs))
        throw new Fallback("check-card", gitLine(cwd, diffArgs), "the card branch changes nightshift.json");
      const dirty = await run("check-card", worktree, ["status", "--porcelain"]);
      if (dirty)
        throw new Fallback(
          "check-card",
          gitLine(worktree, ["status", "--porcelain"]),
          `the card worktree has uncommitted changes:\n${dirty}`,
        );
    } else {
      for (const sha of fields.commits) {
        if (!(await ok(cwd, ["merge-base", "--is-ancestor", sha, base]))) {
          throw new Fallback("check-commits", gitLine(cwd, ["merge-base", "--is-ancestor", sha, base]), `commit ${sha} is not on ${base}`);
        }
      }
    }
    check();

    // Bring the base up to date with its upstream.
    let state = NOTHING_CHANGED;
    const upstreamRes = await git(cwd, ["rev-parse", "--abbrev-ref", `${base}@{upstream}`]);
    const upstream = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : "";
    let remote = "";
    if (upstream) {
      remote = await run("upstream", cwd, ["config", "--get", `branch.${base}.remote`]);
      await run("upstream", cwd, ["fetch", remote]);
      const baseSha = await run("upstream", cwd, ["rev-parse", base]);
      const upSha = await run("upstream", cwd, ["rev-parse", upstream]);
      if (baseSha !== upSha && !(await ok(cwd, ["merge-base", "--is-ancestor", upSha, baseSha]))) {
        if (!(await ok(cwd, ["merge-base", "--is-ancestor", baseSha, upSha]))) {
          throw new Fallback(
            "upstream",
            gitLine(cwd, ["merge-base", "--is-ancestor", baseSha, upSha]),
            `${base} (${baseSha}) and ${upstream} (${upSha}) diverged`,
          );
        }
        await run("upstream", await getBaseCheckout(), ["merge", "--ff-only", upstream]);
        state = `${base} was fast-forwarded to ${upstream} (${short(upSha)}); nothing else changed`;
      }
    }
    check();

    let mergeLine: string;
    let suiteLine: string;
    let worktreeLine = "- Worktree removed: none";
    let branchLine = "- Card branch deleted: none";

    if (worktree) {
      const checkout = await getBaseCheckout();
      check();
      const alreadyMerged = await ok(cwd, ["merge-base", "--is-ancestor", cardBranch, base]);
      if (alreadyMerged) {
        suiteLine = "- Suite: skipped (already merged)";
      } else if (await ok(cwd, ["merge-base", "--is-ancestor", base, cardBranch])) {
        suiteLine = "- Suite: skipped (base unchanged)";
      } else {
        const mode = input.column.fastMergeMovedBase ?? "test";
        const command = input.column.fastMergeTestCommand?.trim() ?? "";
        if (mode === "agent") {
          throw new Fallback("moved-base", "", `${base} moved since the card started, and the column sends this case to the agent`, state);
        }
        if (mode === "test" && !command) {
          throw new Fallback(
            "moved-base",
            "",
            `${base} moved since the card started, and the column has no fast-merge test command`,
            state,
          );
        }
        const mergeArgs = ["merge", "--no-edit", base];
        const r = await git(worktree, mergeArgs);
        if (r.code !== 0) {
          await git(worktree, ["merge", "--abort"]);
          throw new Fallback(
            "merge-base-into-card",
            gitLine(worktree, mergeArgs),
            oneLine(`${r.stdout}\n${r.stderr}`, 2000),
            `${state}. The merge was aborted.`,
          );
        }
        const mergedSha = await run("merge-base-into-card", worktree, ["rev-parse", "HEAD"]);
        const kept = `the merge commit of ${base} (${short(mergedSha)}) stays on ${cardBranch}; ${base} was not changed by it`;
        if (mode === "test") {
          check();
          const t = await runTestCommand(command, worktree, input.testTimeoutMs ?? TEST_TIMEOUT_MS, input.isCancelled);
          check();
          if (t.code !== 0) {
            const why = t.timedOut ? `timed out after ${Math.round((input.testTimeoutMs ?? TEST_TIMEOUT_MS) / 1000)} s` : `exit ${t.code}`;
            throw new Fallback("test", command, `${why}\n${tail(t.output, TEST_TAIL_LINES)}`, kept);
          }
          suiteLine = `- Suite: ${command} → exit 0`;
        } else {
          suiteLine = "- Suite: skipped (setting merge)";
        }
        state = kept;
      }
      check();
      if (!alreadyMerged) await run("ff-base", checkout, ["merge", "--ff-only", cardBranch], state);
      const head = await run("ff-base", cwd, ["rev-parse", base]);
      mergeLine = alreadyMerged
        ? `- Merge commit: already in ${base} (${short(head)})`
        : `- Merge commit: ${head} (fast-forward, merge rapide)`;
    } else {
      const head = await run("check-commits", cwd, ["rev-parse", base]);
      mergeLine = `- Merge commit: none (committed on ${base}, ${short(head)})`;
      suiteLine = "- Suite: skipped (no worktree)";
    }

    // Push the base, never forced.
    const head = await run("push", cwd, ["rev-parse", base]);
    let pushedLine = "- Pushed: skipped, no upstream";
    if (upstream) {
      const pushArgs = ["push", remote, base];
      const r = await git(cwd, pushArgs);
      if (r.code !== 0) {
        const partial = [...notes, `- Into: ${base}`, testLine, mergeLine, `- Pushed: failed (${oneLine(r.stderr)})`].join("\n");
        const kept = worktree ? `the local merge is kept on ${base} at ${head}, not pushed` : `${base} is at ${head}, not pushed`;
        throw new Fallback("push", gitLine(cwd, pushArgs), oneLine(`${r.stderr}\n${r.stdout}`, 2000), kept, partial);
      }
      pushedLine = `- Pushed: ${remote}/${base} at ${short(head)}`;
    }

    // Cleanup: nothing here undoes the merge, it is already pushed.
    if (worktree) {
      const cache = join(worktree, ".testmondata");
      if (existsSync(cache)) {
        try {
          const tmp = join(cwd, `.testmondata.${process.pid}.tmp`);
          copyFileSync(cache, tmp);
          renameSync(tmp, join(cwd, ".testmondata"));
        } catch {}
      }
      const rm = await git(cwd, ["worktree", "remove", worktree]);
      worktreeLine = rm.code === 0 ? `- Worktree removed: ${worktree}` : `- Worktree removed: failed (${oneLine(rm.stderr)})`;
      const refs = (await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/nightshift/"])).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((b) => b === cardBranch || b.startsWith(`${cardBranch}--`) || b.startsWith(`${cardBranch}/`));
      const deleted: string[] = [];
      const failed: string[] = [];
      const from = baseCheckout ?? cwd;
      for (const b of refs) {
        const d = await git(from, ["branch", "-d", b]);
        if (d.code === 0) deleted.push(b);
        else failed.push(`${b}: ${oneLine(d.stderr, 120)}`);
      }
      branchLine = `- Card branch deleted: ${deleted.join(", ") || "none"}${failed.length ? `; failed (${failed.join("; ")})` : ""}`;
    }

    const merge = [...notes, `- Into: ${base}`, testLine, mergeLine, pushedLine, worktreeLine, branchLine, suiteLine].join("\n");
    return { kind: "merged", summary: `merge rapide : ${base} @ ${short(head)}`, merge };
  } catch (e) {
    if (e instanceof Cancelled) return { kind: "cancelled" };
    if (e instanceof Fallback) {
      return {
        kind: "fallback",
        step: e.step,
        command: e.command,
        error: e.detail,
        state: e.state,
        ...(e.merge || notes.length ? { merge: [...notes, ...(e.merge ? [e.merge] : [])].join("\n") } : {}),
      };
    }
    return {
      kind: "fallback",
      step: "internal",
      command: "",
      error: (e as Error)?.message ?? String(e),
      state: "unknown: check the base and the card worktree",
    };
  } finally {
    if (tempBase) {
      await git(cwd, ["worktree", "remove", "--force", tempBase]);
      rmSync(tempBase, { recursive: true, force: true });
    }
    if (lockPath) rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Block appended to the agent prompt when the fast path stopped. */
export function fallbackBlock(o: Extract<FastMergeOutcome, { kind: "fallback" }>): string {
  return [
    "<fast-merge>",
    "Nightshift tried a deterministic merge before starting you, and stopped.",
    `Step: ${o.step}`,
    `Command: ${o.command || "(none)"}`,
    `Error: ${o.error.slice(0, 2000)}`,
    `State left: ${o.state}`,
    ...(o.merge ? ["Merge lines written so far:", o.merge] : []),
    "The merge lock is released and no merge is in progress. Apply the nightshift-merge skill from its first step.",
    "</fast-merge>",
  ].join("\n");
}
