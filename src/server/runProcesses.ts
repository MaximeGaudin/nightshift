// Finds and stops every process of one run: the agent (or test command) and whatever it started, background
// commands included. Claude Code runs each Bash command in its own process group, so signalling the agent's group is
// not enough: a run's processes are found through the process tree, the snapshots the run registry keeps, and an
// environment token every descendant inherits. A process is never matched by name.
//
// macOS hides the environment of platform binaries (/bin/sh, /bin/sleep…) from `ps e`, so the token alone misses
// shells; the process tree and the tracked snapshots cover them. Linux exposes /proc/<pid>/environ for the user's own
// processes.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps` lstart, compared as an opaque string: guards against a reused pid. */
  startedAt: string;
  /** Exited, not reaped yet: counts as dead. */
  zombie?: boolean;
}

export interface TrackedProc {
  pid: number;
  pgid: number;
  startedAt: string;
}

export interface RunHandle {
  /** Value of NIGHTSHIFT_RUN_TOKEN in the root's environment, inherited by its descendants. */
  token: string;
  /** The agent (claude) or the test command's sh. */
  rootPid: number;
  /** lstart of the root, read once after spawn; undefined when unknown (the root then counts while alive). */
  rootStartedAt?: string;
  /** Latest snapshot of the root's descendants, kept by the run registry's tracker. */
  tracked: TrackedProc[];
}

export const RUN_TOKEN_ENV = "NIGHTSHIFT_RUN_TOKEN";
/** SIGTERM first so traps can clean up, then SIGKILL after this delay. */
export const STOP_GRACE_MS = 5000;

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newRunToken(): string {
  const bytes = randomBytes(24);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;

/** Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=` output. */
export function parseProcessTable(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      startedAt: m[5] as string,
      ...((m[4] as string).includes("Z") ? { zombie: true } : {}),
    });
  }
  return out;
}

async function run(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: PS_ENV });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? text : "";
  } catch {
    return "";
  }
}

/** Every process of the machine visible to this user; [] when `ps` fails. */
export async function readProcessTable(): Promise<ProcInfo[]> {
  return parseProcessTable(await run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]));
}

/** lstart of one process, read synchronously; undefined when it is not running or `ps` fails. */
export function processStartedAt(pid: number): string | undefined {
  try {
    const r = Bun.spawnSync(["ps", "-o", "pid=,ppid=,pgid=,stat=,lstart=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: PS_ENV,
    });
    const p = parseProcessTable(r.stdout.toString()).find((x) => x.pid === pid);
    return p && !p.zombie ? p.startedAt : undefined;
  } catch {
    return undefined;
  }
}

/** Pids of the processes whose environment holds this run token (when the OS shows it); [] on failure. */
export async function findTokenPids(token: string): Promise<number[]> {
  if (!/^[a-z0-9]+$/.test(token)) return [];
  const needle = `${RUN_TOKEN_ENV}=${token}`;
  if (process.platform === "linux") {
    const out: number[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      try {
        if (readFileSync(`/proc/${e}/environ`, "latin1").split("\0").includes(needle)) out.push(Number(e));
      } catch {}
    }
    return out;
  }
  const text = await run(["ps", "axeww", "-o", "pid=,command="]);
  const re = new RegExp(`(?:^|\\s)${needle}(?:\\s|$)`);
  const out: number[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && re.test(m[2] as string)) out.push(Number(m[1]));
  }
  return out;
}

/** This process and all its ancestors: never signalled, whatever a run's set says. */
export function protectedPids(table: ProcInfo[]): Set<number> {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = new Set<number>([process.pid]);
  let cur = byPid.get(process.pid);
  while (cur && cur.ppid > 0 && !out.has(cur.ppid)) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/**
 * The run's live processes in `table`: the root (start time checked), the tracked processes whose pid and start time
 * still match, the token holders, then everything they lead (descendants through ppid, members of a group whose
 * leader is in the set). Zombies and `exclude` never count.
 */
export function collectRunProcesses(table: ProcInfo[], h: RunHandle, tokenPids: number[], exclude: Set<number>): ProcInfo[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const set = new Map<number, ProcInfo>();
  const add = (p: ProcInfo | undefined) => {
    if (p && !p.zombie && !exclude.has(p.pid)) set.set(p.pid, p);
  };
  const root = byPid.get(h.rootPid);
  if (root && (h.rootStartedAt === undefined || root.startedAt === h.rootStartedAt)) add(root);
  for (const t of h.tracked) {
    const p = byPid.get(t.pid);
    if (p && p.startedAt === t.startedAt) add(p);
  }
  for (const pid of tokenPids) add(byPid.get(pid));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of table) {
      if (set.has(p.pid) || p.zombie || exclude.has(p.pid)) continue;
      const leader = set.get(p.pgid);
      if (set.has(p.ppid) || (leader && leader.pid === p.pgid)) {
        add(p);
        changed = true;
      }
    }
  }
  return [...set.values()];
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig);
  } catch {}
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function snapshot(h: RunHandle): Promise<{ table: ProcInfo[]; procs: ProcInfo[] }> {
  const [table, tokens] = await Promise.all([readProcessTable(), findTokenPids(h.token)]);
  return { table, procs: collectRunProcesses(table, h, tokens, protectedPids(table)) };
}

/**
 * Stops every process of the run: SIGTERM to each one, up to `graceMs` for them to exit, then SIGKILL to whatever is
 * left (collected again, so children a trap started are caught). Resolves at once when nothing is left; never rejects.
 */
export async function stopRunProcesses(h: RunHandle, graceMs = STOP_GRACE_MS): Promise<void> {
  try {
    const first = await snapshot(h);
    if (first.table.length === 0) {
      // `ps` failed: the root and its group (it leads one, being spawned detached) are all that can be reached.
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        signal(-h.rootPid, sig);
        signal(h.rootPid, sig);
        if (sig === "SIGTERM") await Bun.sleep(Math.min(graceMs, 1000));
      }
      return;
    }
    if (first.procs.length === 0) return;
    for (const p of first.procs) signal(p.pid, "SIGTERM");
    let remaining = first.procs;
    const end = Date.now() + graceMs;
    let lastTable = Date.now();
    while (remaining.length > 0 && Date.now() < end) {
      await Bun.sleep(50);
      remaining = remaining.filter((p) => alive(p.pid));
      // A killed process whose parent has not reaped it yet still answers kill(0): drop the zombies.
      if (remaining.length > 0 && Date.now() - lastTable > 500) {
        lastTable = Date.now();
        const table = await readProcessTable();
        remaining = remaining.filter((p) => table.some((q) => q.pid === p.pid && q.startedAt === p.startedAt && !q.zombie));
      }
    }
    // Collect again: a trap may have started children, an orphan may have been re-parented.
    const known: TrackedProc[] = first.procs.map(({ pid, pgid, startedAt }) => ({ pid, pgid, startedAt }));
    const second = await snapshot({ ...h, tracked: [...h.tracked, ...known] });
    for (const p of second.procs) signal(p.pid, "SIGKILL");
  } catch {}
}
