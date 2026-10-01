import { PROGRESS_RULE } from "./orchestrator.ts";

/** Longest instruction accepted with a quick run. */
export const QUICK_INSTRUCTION_MAX = 2000;

/** Structured output of a quick run (--json-schema). */
export const QUICK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["success", "error"],
      description: 'Use "success" when the skill did what was asked, "error" when you could not complete it.',
    },
    summary: { type: "string", description: "One or two sentences: what you did, or why you could not continue." },
  },
  required: ["status", "summary"],
  additionalProperties: false,
};

/** Prompt of a quick run: no card. It goes through stdin, never argv. */
export function buildQuickRunPrompt(skillName: string, skillPath: string | undefined, instruction: string): string {
  const text = instruction.trim();
  return `You are an automated worker driven by Nightshift, a kanban board that orchestrates AI agents.
A human launched the skill "${skillName}" from the command palette. There is no card: you run this skill once, on its own.

Invoke the skill with the Skill tool (skill name: "${skillName}")${skillPath ? `; its definition lives at ${skillPath}` : ""}. Follow its instructions.
${text ? `\nThe user gave this instruction, apply it:\n<instruction>\n${text}\n</instruction>\n` : "\nThe user gave no instruction: rely on the skill's own defaults.\n"}
Rules:
- There is no card and no human can answer you while you run. The AskUserQuestion tool is disabled: do not use it. Work autonomously and pick sensible defaults.
- If you cannot continue, return the structured output with status "error" and a summary explaining why.
${PROGRESS_RULE}
- Never edit nightshift.json yourself.
- Never kill processes by name or pattern (pkill -f, killall, kill $(pgrep …)): other agents run on this machine and their processes can match. Only kill PIDs you started yourself.
- Return the structured output exactly once, at the very end. If you started background work (subagents, background shells), wait until all of it has finished first. Never return an interim or "in progress" result.
- When finished, return the structured output:
  - status: "success" or "error".
  - summary: a short summary of what you did, or why you could not continue.`;
}

/** Reads the untrusted structured output of a quick run; null when it does not have the expected shape. */
export function parseQuickOutput(out: unknown): { status: "success" | "error"; summary: string } | null {
  if (typeof out !== "object" || out === null || Array.isArray(out)) return null;
  const { status, summary } = out as Record<string, unknown>;
  if ((status !== "success" && status !== "error") || typeof summary !== "string") return null;
  return { status, summary: summary.trim() };
}
