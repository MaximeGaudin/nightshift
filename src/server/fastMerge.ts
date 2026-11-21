// Deterministic merge tried before the nightshift-merge agent. The skill stays the reference of the behaviour:
// this module only covers the mechanical path and falls back to the agent on anything unexpected.

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
