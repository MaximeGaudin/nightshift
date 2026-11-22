// Code host capability of a provider: pull requests and their checks. Only implementations know a provider id;
// the orchestrator, the PR flow and the CI watcher use this interface (see registry.ts).

import type { MergeMethod } from "../../shared/pullRequests.ts";

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface PrInfo {
  url: string;
  number: number;
  state: PrState;
  body: string;
  mergeable: PrMergeable;
  /** Full sha of the merge commit, once merged. */
  mergeCommit?: string;
  baseRefName: string;
  /** Draft pull request: GitHub refuses to merge it until it is marked ready. */
  isDraft: boolean;
  /** Full sha of the PR head commit, when the host reports it. */
  headSha?: string;
}

export interface FailedCheck {
  name: string;
  link: string;
}

/** Checks of a PR (the required ones or all of them, as asked): `none` when none has reported. */
export interface ChecksSummary {
  state: "none" | "pending" | "pass" | "fail";
  failed: FailedCheck[];
}

export type MergeResult = { ok: true } | { ok: false; kind: "conflict" | "protected" | "other"; message: string };

export interface CodeHost {
  /** The host CLI is installed and authenticated for this project. */
  available(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The pull request whose head is `head` (open first), or null when there is none. */
  findPr(cwd: string, head: string): Promise<PrInfo | null>;
  /** Opens a pull request and returns its URL. */
  createPr(cwd: string, pr: { base: string; head: string; title: string; body: string; draft?: boolean }): Promise<string>;
  updatePr(cwd: string, url: string, pr: { title: string; body: string }): Promise<void>;
  /** Marks a draft pull request ready for review. */
  markReady(cwd: string, url: string): Promise<void>;
  /** Converts an open pull request back to a draft. */
  markDraft(cwd: string, url: string): Promise<void>;
  /** The PR by URL (state, mergeability, merge commit). */
  prState(cwd: string, url: string): Promise<PrInfo | null>;
  /** Checks of a PR: the required ones by default, every reported check with `all: true`. */
  checks(cwd: string, url: string, opts?: { all?: boolean }): Promise<ChecksSummary>;
  /**
   * The base branch requires at least one status check (branch protection or ruleset). Never throws: an unreadable
   * answer is `false`, so Nightshift waits for the checks itself instead of trusting the host's auto-merge.
   */
  requiredChecks(cwd: string, base: string): Promise<boolean>;
  mergePr(cwd: string, url: string, opts: { method: MergeMethod; auto: boolean }): Promise<MergeResult>;
  disableAutoMerge(cwd: string, url: string): Promise<void>;
  /** Log excerpt of a failed check (its last `maxLines` lines); empty when the link is not a CI run. */
  failedLogs(cwd: string, link: string, maxLines: number): Promise<string>;
}

export type CodeHostErrorKind = "missing" | "auth" | "network" | "other";

/** Technical failure of a code host call (not a business state). The message is cleaned and capped. */
export class CodeHostError extends Error {
  readonly kind: CodeHostErrorKind;
  constructor(kind: CodeHostErrorKind, message: string) {
    super(message.replace(/\s+/g, " ").trim().slice(0, 300));
    this.name = "CodeHostError";
    this.kind = kind;
  }
}
