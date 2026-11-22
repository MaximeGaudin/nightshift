// Pull request flow, shared by the server and the web: board settings, the `- PR:` lines a card carries,
// and the body Nightshift writes on a pull request. Client-safe: no I/O.

import type { Board } from "./types.ts";

export const PULL_REQUESTS_SETTINGS = ["auto", "off"] as const;
export type PullRequestsSetting = (typeof PULL_REQUESTS_SETTINGS)[number];
export const DEFAULT_PULL_REQUESTS: PullRequestsSetting = "auto";

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const DEFAULT_MERGE_METHOD: MergeMethod = "merge";

/** The three pull request settings of a board, as the settings dialog edits them. */
export interface PullRequestSettings {
  pullRequests: PullRequestsSetting;
  mergeMethod: MergeMethod;
  autoMerge: boolean;
}

/** Effective pull request settings of a board. */
export function pullRequestSettingsOf(board: Pick<Board, "pullRequests" | "mergeMethod" | "autoMerge">): PullRequestSettings {
  return { pullRequests: pullRequestsOf(board), mergeMethod: mergeMethodOf(board), autoMerge: autoMergeOf(board) };
}

/** The board's pull request setting; the only place that reads `board.pullRequests`. */
export function pullRequestsOf(board: Pick<Board, "pullRequests">): PullRequestsSetting {
  return board.pullRequests && PULL_REQUESTS_SETTINGS.includes(board.pullRequests) ? board.pullRequests : DEFAULT_PULL_REQUESTS;
}

/** The board's merge method for pull requests. */
export function mergeMethodOf(board: Pick<Board, "mergeMethod">): MergeMethod {
  return board.mergeMethod && MERGE_METHODS.includes(board.mergeMethod) ? board.mergeMethod : DEFAULT_MERGE_METHOD;
}

/** Whether pending required checks schedule a GitHub auto-merge. Off by default. */
export function autoMergeOf(board: Pick<Board, "autoMerge">): boolean {
  return board.autoMerge === true;
}

// ---- sections of a card description ---------------------------------------------------------------------------

/** Body of a `## <heading>` section, or undefined when the note has none. */
export function section(description: string, heading: string): string | undefined {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Value of a `- Key: value` line, without backticks; undefined when the line is missing. */
export function field(body: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1].replace(/`/g, "").trim() : undefined;
}

/**
 * Sets the single `- PR: <value>` line of a section: replaces the first one, drops any other, or appends one.
 * Creates the section at the end of the note when it is missing. Every other line stays byte for byte.
 */
export function setSectionPrLine(description: string, heading: string, value: string): string {
  return setSectionField(description, heading, "PR", value);
}

/**
 * Same as `setSectionPrLine` for any `- <key>: <value>` line (key matched case-insensitively). `frenchColon` writes
 * `- <key> : <value>`, the French typography of the lines written in French.
 */
export function setSectionField(description: string, heading: string, key: string, value: string, frenchColon = false): string {
  const keyLine = new RegExp(`^\\s*[-*]\\s*${key}\\s*:.*$`, "i");
  const line = `- ${key}${frenchColon ? " " : ""}: ${value}`;
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) {
    const trimmed = description.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading}\n\n${line}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const first = body.findIndex((l) => keyLine.test(l));
  let next: string[];
  if (first >= 0) {
    next = body.filter((l, i) => i === first || !keyLine.test(l));
    next[next.findIndex((l) => keyLine.test(l))] = line;
  } else {
    // Insert after the last non-blank line of the section.
    let last = body.length - 1;
    while (last >= 0 && body[last].trim() === "") last--;
    next = last < 0 ? ["", line, ...body] : [...body.slice(0, last + 1), line, ...body.slice(last + 1)];
  }
  return [...lines.slice(0, start + 1), ...next, ...lines.slice(end)].join("\n");
}

/** URL of the card's pull request: the `- PR:` line under `## Review` (or `## Merge`), when it is an http(s) URL. */
export function prUrlOf(description: string): string | undefined {
  for (const heading of ["Review", "Merge"]) {
    const body = section(description, heading);
    const value = body !== undefined ? field(body, "PR") : undefined;
    const url = value?.split(/\s+/)[0];
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

// ---- CI status of a card's pull request ------------------------------------------------------------------------

export type PrCiState = "pass" | "pending" | "fail" | "none" | "conflict" | "merged" | "closed";

/** Display-only CI status of a PR: in memory on the server, pushed to the clients in the snapshot. */
export interface PrCiStatus {
  /** The PR URL this status belongs to. */
  url: string;
  state: PrCiState;
  /** Failed checks; non-empty only when `state` is `fail`. */
  failed: { name: string; link: string }[];
  /** ISO time of the last successful fetch. */
  checkedAt: string;
}

// ---- merge status ----------------------------------------------------------------------------------------------

export type MergeStatusKind = "pending" | "auto" | "ready" | "closed" | "merged";

/** Exact suffixes of the `- PR: <url> — …` status line under `## Merge`. */
export const MERGE_STATUS_TEXT: Record<Exclude<MergeStatusKind, "merged">, string> = {
  pending: "checks en attente",
  auto: "auto-merge programmé",
  ready: "checks verts, prêt à merger",
  closed: "fermée sans merge",
};

/** The status line written under `## Merge`. */
export function mergeStatusLine(url: string, status: MergeStatusKind, sha?: string): string {
  if (status === "merged") return `- PR: ${url} merged (${sha ?? "?"})`;
  return `- PR: ${url} — ${MERGE_STATUS_TEXT[status]}`;
}

/** Reads the PR status line of `## Merge`; undefined when there is none. */
export function parseMergeStatus(description: string): { url: string; status: MergeStatusKind; sha?: string } | undefined {
  const body = section(description, "Merge");
  if (body === undefined) return undefined;
  const value = field(body, "PR");
  if (!value) return undefined;
  const merged = /^(\S+)\s+merged\s+\(([^)]*)\)/.exec(value);
  if (merged) return { url: merged[1], status: "merged", sha: merged[2] };
  const m = /^(\S+)\s+—\s+(.*)$/.exec(value);
  if (!m) return undefined;
  const kind = (Object.keys(MERGE_STATUS_TEXT) as Exclude<MergeStatusKind, "merged">[]).find((k) => MERGE_STATUS_TEXT[k] === m[2].trim());
  return kind ? { url: m[1], status: kind } : undefined;
}

/** Writes (or replaces) the single `- Problème : <text>` line of `## Merge`: why the CI watcher started a new merge cycle. */
export function writeMergeProblem(description: string, text: string): string {
  return setSectionField(description, "Merge", "Problème", text, true);
}

/** Writes (or replaces) the PR status line of `## Merge`, creating the section when needed. */
export function writeMergeStatus(description: string, url: string, status: MergeStatusKind, sha?: string): string {
  return setSectionPrLine(description, "Merge", mergeStatusLine(url, status, sha).replace(/^- PR: /, ""));
}

// ---- pull request body -----------------------------------------------------------------------------------------

export const SCREENSHOTS_START = "<!-- nightshift-screenshots:start -->";
export const SCREENSHOTS_END = "<!-- nightshift-screenshots:end -->";
export const MAX_PR_BODY = 60_000;

/** The screenshots block #71 maintains in a PR body, markers included; undefined when absent. */
export function screenshotsBlock(body: string): string | undefined {
  const start = body.indexOf(SCREENSHOTS_START);
  if (start < 0) return undefined;
  const end = body.indexOf(SCREENSHOTS_END, start);
  if (end < 0) return undefined;
  return body.slice(start, end + SCREENSHOTS_END.length);
}

const RESULT_PLUMBING = /^\s*[-*]\s*(Worktree|Branch|Base|Commits|Shared checkout)\s*:/i;

/**
 * A project whose pull requests follow its own rules (title format, required sections) has its review agent write
 * `## Pull request`: an optional first line `Title: <title>`, then the body, with `###` headings so the section
 * stays one section of the note. Nightshift then uses them instead of the card title and the generated body.
 */
export const PR_SECTION = "Pull request";
const PR_TITLE_LINE = /^\s*Title\s*:\s*(.+?)\s*$/i;

/** The `## Pull request` section split into its title line and its body; undefined parts are absent or empty. */
function prSection(description: string): { title?: string; body?: string } {
  const raw = section(description, PR_SECTION);
  if (raw === undefined) return {};
  const lines = raw.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const m = first >= 0 ? lines[first].match(PR_TITLE_LINE) : null;
  if (m) lines.splice(first, 1);
  const body = lines.join("\n").trim();
  return { title: m?.[1].replace(/`/g, "").trim() || undefined, body: body || undefined };
}

/** Title of the card's pull request: the `Title:` line of `## Pull request`, else the card title. */
export function buildPrTitle(card: { title: string; description: string }): string {
  return prSection(card.description).title ?? card.title;
}

/**
 * Body Nightshift writes on the card's pull request: the body of `## Pull request` when the review wrote one,
 * else summary (`## Result` without its git plumbing lines), Definition of done and `## Review`; then the card
 * reference and the screenshots block of the previous body, verbatim.
 */
export function buildPrBody(card: { id: string; number: number; description: string }, previousBody = ""): string {
  const d = card.description;
  const own = prSection(d).body;
  if (own !== undefined) {
    const shots = screenshotsBlock(previousBody);
    const tail = [`Nightshift card: #${card.number} (${card.id})`, ...(shots ? [shots] : [])].join("\n\n");
    const room = MAX_PR_BODY - tail.length - 4;
    const kept = own.length > room ? `${own.slice(0, Math.max(0, room - 2))}\n…` : own;
    return `${kept}\n\n${tail}`.slice(0, MAX_PR_BODY);
  }
  const parts: { heading: string; body: string }[] = [];
  const result = section(d, "Result");
  if (result !== undefined) {
    const kept = result
      .split("\n")
      .filter((l) => !RESULT_PLUMBING.test(l))
      .join("\n")
      .trim();
    if (kept) parts.push({ heading: "Summary", body: kept });
  }
  const dod = section(d, "Definition of done")?.trim();
  if (dod) parts.push({ heading: "Definition of done", body: dod });
  const review = section(d, "Review")?.trim();
  const footer = `Nightshift card: #${card.number} (${card.id})`;
  const shots = screenshotsBlock(previousBody);
  const render = (reviewBody: string | undefined) =>
    [
      ...parts.map((p) => `## ${p.heading}\n\n${p.body}`),
      ...(reviewBody ? [`## Review\n\n${reviewBody}`] : []),
      footer,
      ...(shots ? [shots] : []),
    ].join("\n\n");
  let body = render(review);
  if (body.length > MAX_PR_BODY && review) {
    const over = body.length - MAX_PR_BODY + 20;
    body = render(`${review.slice(0, Math.max(0, review.length - over))}\n\n…`);
  }
  if (body.length > MAX_PR_BODY) body = body.slice(0, MAX_PR_BODY);
  return body;
}
