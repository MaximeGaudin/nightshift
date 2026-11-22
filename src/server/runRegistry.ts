// The runs a Nightshift process has started, on disk, so the next process can clean up after a crash.
// One file per orchestrator instance (several live in one test process): NIGHTSHIFT_HOME/runs/<serverPid>-<rand>.json.
// A tracker snapshots each run's descendants every few seconds: after a crash their parents are gone, and on macOS a
// platform binary (sh, sleep) does not show its environment token, so the snapshot is how they are found again.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import {
  collectRunProcesses,
  processStartedAt,
  protectedPids,
  type RunHandle,
  readProcessTable,
  type TrackedProc,
} from "./runProcesses.ts";

export type RunKind = "card" | "quick" | "aside" | "test";

export interface RunEntry {
  id: string;
  kind: RunKind;
  /** Absolute project path. */
  project: string;
  cardId?: string;
  columnId?: string;
  enteredColumnAt?: string;
  /** ISO time the process was spawned. */
  startedAt: string;
  /** Card runs: the session once known, else the session being resumed. */
  sessionId?: string;
  token: string;
  rootPid: number;
  rootStartedAt?: string;
  tracked: TrackedProc[];
}

interface RegistryFile {
  version: 1;
  serverPid: number;
  /** Epoch ms the server process started: a file from before the last boot belongs to a dead server. */
  serverStartedAtMs: number;
  entries: RunEntry[];
}

/** The live handle of a registered run: the tracker updates its `tracked` list in place. */
export type LiveRun = RunHandle & { id: string };

export type NewRunEntry = Omit<RunEntry, "id" | "tracked" | "rootStartedAt" | "token" | "rootPid">;

/** Margin on the boot time computed from uptime (clock adjustments). */
const BOOT_SLACK_MS = 60_000;

/** How often the tracker snapshots the descendants of the live runs. */
export const TRACK_INTERVAL_MS = 2000;

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function bootTimeMs() {
  return Date.now() - uptime() * 1000 - BOOT_SLACK_MS;
}

export class RunRegistry {
  private readonly dir: string;
  private readonly file: string;
  private readonly runs = new Map<string, { entry: RunEntry; handle: LiveRun }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly serverStartedAtMs = Date.now() - process.uptime() * 1000;
  private lastWritten = "";
  private closed = false;

  constructor(home: string) {
    this.dir = join(home, "runs");
    this.file = join(this.dir, `${process.pid}-${randomBytes(3).toString("hex")}.json`);
  }

  /** Registers a spawned process; the returned handle is what stopRunProcesses needs. Never throws. */
  add(e: NewRunEntry, token: string, rootPid: number): LiveRun {
    const handle: LiveRun = { id: randomBytes(6).toString("hex"), token, rootPid, tracked: [] };
    this.runs.set(handle.id, { entry: { ...e, id: handle.id, token, rootPid, tracked: [] }, handle });
    this.write();
    // Read asynchronously: a synchronous spawn crashes Bun 1.2.15 while other processes are being spawned.
    void processStartedAt(rootPid).then((started) => {
      if (!started || !this.runs.has(handle.id)) return;
      handle.rootStartedAt = started;
      this.write();
    });
    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => void this.track(), TRACK_INTERVAL_MS);
      this.timer.unref?.();
    }
    return handle;
  }

  setSessionId(id: string, sessionId: string) {
    const run = this.runs.get(id);
    if (!run || run.entry.sessionId === sessionId) return;
    run.entry.sessionId = sessionId;
    this.write();
  }

  remove(id: string) {
    if (!this.runs.delete(id)) return;
    if (this.runs.size === 0) this.stopTimer();
    this.write();
  }

  /** Snapshots the descendants of every live run into the file (the tracker's tick; exposed for tests). */
  async track() {
    if (this.runs.size === 0 || this.closed) return;
    const table = await readProcessTable();
    if (table.length === 0 || this.closed) return;
    const exclude = protectedPids(table);
    for (const { handle } of this.runs.values()) {
      handle.tracked = collectRunProcesses(table, handle, [], exclude).map(({ pid, pgid, startedAt }) => ({ pid, pgid, startedAt }));
    }
    this.write();
  }

  /** Synchronous: the entries of every file whose server is dead. Called once, before any project opens. */
  readDeadEntries(): RunEntry[] {
    return this.deadFiles().flatMap((f) => f.data?.entries ?? []);
  }

  /** Rewrites the dead files keeping only their card entries (still to be marked); deletes a file left empty. */
  dropNonCardDeadEntries() {
    for (const f of this.deadFiles()) {
      this.rewrite(
        f.path,
        f.data,
        (f.data?.entries ?? []).filter((e) => e.kind === "card"),
      );
    }
  }

  /** Removes and returns the dead card entries of this project; drops the entries whose project folder is gone. */
  takeInterrupted(projectPath: string): RunEntry[] {
    const taken: RunEntry[] = [];
    for (const f of this.deadFiles()) {
      const keep: RunEntry[] = [];
      for (const e of f.data?.entries ?? []) {
        if (e.kind === "card" && e.project === projectPath) taken.push(e);
        else if (existsSync(e.project)) keep.push(e);
      }
      this.rewrite(f.path, f.data, keep);
    }
    return taken;
  }

  /** Stops the tracker and deletes this instance's file. */
  close() {
    this.closed = true;
    this.stopTimer();
    this.runs.clear();
    rmSync(this.file, { force: true });
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private write() {
    if (this.closed) return;
    try {
      if (this.runs.size === 0) {
        rmSync(this.file, { force: true });
        this.lastWritten = "";
        return;
      }
      const data: RegistryFile = {
        version: 1,
        serverPid: process.pid,
        serverStartedAtMs: this.serverStartedAtMs,
        entries: [...this.runs.values()].map(({ entry, handle }) => ({
          ...entry,
          ...(handle.rootStartedAt ? { rootStartedAt: handle.rootStartedAt } : {}),
          tracked: handle.tracked,
        })),
      };
      const text = JSON.stringify(data);
      if (text === this.lastWritten) return;
      mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.file, data);
      this.lastWritten = text;
    } catch (e) {
      console.error(`Could not write the run registry ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private rewrite(path: string, data: RegistryFile | undefined, entries: RunEntry[]) {
    try {
      if (!data || entries.length === 0) rmSync(path, { force: true });
      else if (entries.length !== data.entries.length) writeAtomic(path, { ...data, entries });
    } catch (e) {
      console.error(`Could not update the run registry ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Files of dead servers; a corrupt one is returned without data (so it gets deleted) when its pid is dead. */
  private deadFiles(): { path: string; data: RegistryFile | undefined }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: { path: string; data: RegistryFile | undefined }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      if (path === this.file) continue;
      let data: RegistryFile | undefined;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
        if (parsed && typeof parsed.serverPid === "number" && Array.isArray(parsed.entries)) data = parsed;
      } catch {}
      const pid = data?.serverPid ?? Number(name.split("-")[0]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      // Alive: the same server, unless it started before the last boot (the pid was reused after a reboot).
      if (isAlive(pid) && !(typeof data?.serverStartedAtMs === "number" && data.serverStartedAtMs < bootTimeMs())) continue;
      out.push({ path, data });
    }
    return out;
  }
}
