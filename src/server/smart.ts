// Smart mode, server side: the prompt, the MCP server names, and the `claude -p` call itself (haiku, low effort,
// nothing of the user's setup loaded, no tools). Never throws: every failure comes back as `{ ok: false }`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SMART_EFFORTS, SMART_SCHEMA, type SmartChoice, validateSmartOutput } from "../shared/smart.ts";

export const SMART_TIMEOUT_MS = 30_000;
export const SMART_DESCRIPTION_MAX = 4000;
export const SMART_MCP_NAMES_MAX = 30;
/** First line of every smart prompt: tells it apart from a card run (the test stand-in for claude reads it). */
export const SMART_MARKER = "<nightshift-smart>";

/** 30 s, or NIGHTSHIFT_SMART_TIMEOUT_MS when it is a positive integer (read at each call, for the tests). */
export function smartTimeoutMs(): number {
  const v = Number(process.env.NIGHTSHIFT_SMART_TIMEOUT_MS);
  return Number.isInteger(v) && v > 0 ? v : SMART_TIMEOUT_MS;
}

/** What a cached choice depends on: the card text and the column's skill. */
export function smartFingerprint(title: string, description: string, skill: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([title, description, skill ?? ""]))
    .digest("hex")
    .slice(0, 16);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function serverNames(v: unknown): string[] {
  return isPlainObject(v) && isPlainObject(v.mcpServers) ? Object.keys(v.mcpServers) : [];
}

/** Where Claude Code keeps the user's MCP servers: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeJsonPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

/**
 * Names of the MCP servers configured for this project: global and per-project entries of `.claude.json`, and the
 * project's `.mcp.json`. Only the names ever leave this function, never a command, URL, env or secret.
 */
export function readMcpServerNames(projectPath: string, claudeJson: string = claudeJsonPath()): string[] {
  const user = readJson(claudeJson);
  const project = isPlainObject(user) && isPlainObject(user.projects) ? user.projects[projectPath] : undefined;
  const names = new Set([...serverNames(user), ...serverNames(project), ...serverNames(readJson(join(projectPath, ".mcp.json")))]);
  return [...names]
    .filter((n) => n.trim())
    .sort()
    .slice(0, SMART_MCP_NAMES_MAX);
}

export interface SmartPromptInput {
  title: string;
  description: string;
  columnName: string;
  skill: string | undefined;
  mcpServers: string[];
}

export function buildSmartPrompt(i: SmartPromptInput): string {
  const description =
    i.description.length > SMART_DESCRIPTION_MAX ? `${i.description.slice(0, SMART_DESCRIPTION_MAX)}…[tronqué]` : i.description;
  return `${SMART_MARKER}
You configure one run of a coding agent (Claude Code) on a kanban card. Pick the cheapest configuration that is
still enough for this card and this step. Every feature you turn on costs context and money on every turn.

<card>
<title>${i.title}</title>
<description>
${description}
</description>
</card>

Step: column "${i.columnName}", skill "${i.skill ?? "none"}".

Features (true = load it):
- mcp: the user's MCP servers (external tools). Costly: every server adds its tool definitions to the context. Turn on only when the card needs one of them.${i.mcpServers.length ? ` Configured servers: ${i.mcpServers.join(", ")}.` : " No server names are known."}
- chrome: Claude in Chrome, drives a real browser. Costly. Only for a card that must use a web page in a browser.
- hooks: the user's hooks. Rarely needed; they slow every tool call.
- userSettings: the user's own skills and CLAUDE.md. Cheap; useful when the card relies on the user's skills or conventions.

Effort (${SMART_EFFORTS.join(", ")}): how hard the agent thinks. low for mechanical steps (a trivial merge, a rename, a copy change), medium for ordinary work, high for hard design or debugging.

Return the structured output: the four booleans, the effort, and the reason in one short sentence.`;
}

/** Argv of the smart call: haiku, low effort, structured output, nothing of the user's setup, no tools, no session. */
export function smartArgs(claudePath: string): string[] {
  return [
    claudePath || "claude",
    "-p",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SMART_SCHEMA),
    "--strict-mcp-config",
    "--no-chrome",
    "--settings",
    '{"disableAllHooks":true}',
    "--setting-sources",
    "project,local",
    "--tools",
    "",
    "--no-session-persistence",
  ];
}

export type SmartResult =
  | { ok: true; choice: SmartChoice; costUsd: number; durationMs: number }
  | { ok: false; reason: string; costUsd: number; durationMs: number };

export interface SmartCall {
  claudePath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
  timeoutMs?: number;
  /** Receives the process as soon as it is spawned, so a cancel can kill it. */
  onSpawn?(proc: Subprocess): void;
}

/** The last JSON object printed on stdout (`--output-format json` prints one). */
function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const v: unknown = JSON.parse(line);
      if (isPlainObject(v)) return v;
    } catch {}
  }
  try {
    const v: unknown = JSON.parse(stdout);
    return isPlainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the smart call to completion or timeout. Kills only the process it started. Never throws. */
export async function runSmart(call: SmartCall): Promise<SmartResult> {
  const started = Date.now();
  const timeoutMs = call.timeoutMs ?? smartTimeoutMs();
  const fail = (reason: string, costUsd = 0): SmartResult => ({ ok: false, reason, costUsd, durationMs: Date.now() - started });
  let proc: Subprocess<Uint8Array<ArrayBuffer>, "pipe", "pipe">;
  try {
    proc = Bun.spawn(smartArgs(call.claudePath), {
      cwd: call.cwd,
      env: call.env,
      stdin: new TextEncoder().encode(call.prompt),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return fail(`could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  call.onSpawn?.(proc);
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 2000);
  }, timeoutMs);
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) return fail(`timeout after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`);
    const out = lastJsonObject(stdout);
    const costUsd = Number(out?.total_cost_usd) || 0;
    if (!out) return fail(proc.signalCode ? `killed by ${proc.signalCode}` : `no result (exit code ${proc.exitCode})`);
    if (out.is_error) return fail(String(out.result || out.subtype || "error result").slice(0, 200), costUsd);
    const choice = validateSmartOutput(out.structured_output);
    if (!choice) return fail("invalid output", costUsd);
    return { ok: true, choice, costUsd, durationMs: Date.now() - started };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    if (killTimer && proc.exitCode !== null) clearTimeout(killTimer);
  }
}
