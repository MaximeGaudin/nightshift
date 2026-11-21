// Runs the GitHub CLI without a shell. Never throws on a non-zero exit: callers decide from `code`.
// User text (PR bodies) goes through stdin, never argv.

import { spawn } from "node:child_process";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const GH_TIMEOUT_MS = 60_000;

/** `gh <args>` in `cwd`, with `input` on stdin. Missing binary → 127; still running after the timeout → killed, 124. */
export function gh(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<GhResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("gh", args, {
        cwd,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: (e as Error).message });
      return;
    }
    const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout?.on("data", (d) => {
      stdout += d;
    });
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.stdin?.on("error", () => {});
    if (opts.input !== undefined) proc.stdin?.end(opts.input);
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms`.trim() });
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
