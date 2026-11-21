// Runs git without a shell. Never throws on a non-zero exit: callers decide from `code`.

import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const GIT_TIMEOUT_MS = 120_000;

/**
 * `git <args>` in `cwd`. A prompt for credentials fails instead of blocking (GIT_TERMINAL_PROMPT=0),
 * and a command still running after `timeoutMs` is killed and reported with code 124.
 */
export function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    proc.stdout?.on("data", (d) => {
      stdout += d;
    });
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS} ms`.trim() });
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** The command line as a human would type it, for logs and the agent prompt. */
export function gitLine(cwd: string, args: string[]): string {
  return `git -C ${cwd} ${args.join(" ")}`;
}
