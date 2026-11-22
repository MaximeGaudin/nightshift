// The fake gh state file is shared by every `gh` process of a test file and by the test itself (`fake.setState`).
// A writer reads, changes and rewrites the whole file: without a lock, two overlapping writers lose one write (a
// `gh pr ready` left over from the previous test rewrote a stale state over the PR the next test had just created).
// Writers hold `<state>.lock` from their read to their write; readers need no lock, writes go through a rename.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const LOCK_WAIT_MS = 10_000;

function holderAlive(lock: string): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(`${lock}/pid`, "utf8"));
  } catch {
    return true; // being created: its owner writes the pid right after mkdir
  }
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the state lock (waits up to 10 s, takes over a lock whose process is gone); returns its release. */
export function acquireStateLock(statePath: string): () => void {
  const lock = `${statePath}.lock`;
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/pid`, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!holderAlive(lock)) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > end) throw new Error(`fake gh: state lock ${lock} still held after ${LOCK_WAIT_MS} ms`);
      else Bun.sleepSync(5);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lock, { recursive: true, force: true });
  };
}

/** Writes the whole state through a temporary file and a rename: a reader never sees a half-written file. */
export function writeStateAtomic(statePath: string, text: string) {
  const tmp = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, statePath);
}
