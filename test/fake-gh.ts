#!/usr/bin/env bun
// Stand-in for the `gh` CLI, driven by a JSON state file (FAKE_GH_STATE) and logging each call to FAKE_GH_LOG
// as one JSON line { args, stdin }. Installed on the PATH as `gh` by `installFakeGh` (helpers.ts).
//
// State: { auth?: boolean, remote?: string, nextNumber?: number, mergeError?: string, runLogs?: { [id]: string },
//          defaultChecks?, defaultMergeable? (given to created PRs),
//          prs: [{ number, url, head, base, title, body, state, mergeable, checks?, autoMerge?, mergeCommit?, isDraft? }] }
//        draftError? (makes `pr create --draft` fail)
//        requiredChecks?: true | false | "error" (`gh api` on the base's protection and rules: one required check "ci",
//        none (404 / empty rules), or an HTTP 500)
// `pr merge` on a mergeable PR simulates GitHub on the bare `remote`: the base ref moves to the head sha and,
// with --delete-branch, the head ref is deleted.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface FakePr {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable?: string;
  /** `required: false` checks are left out of `pr checks --required` (default: required). */
  checks?: { name: string; state: string; bucket: string; link: string; required?: boolean }[];
  autoMerge?: boolean;
  mergeCommit?: string;
  method?: string;
  isDraft?: boolean;
}
interface State {
  auth?: boolean;
  remote?: string;
  nextNumber?: number;
  mergeError?: string;
  /** Makes `pr create --draft` fail with this message. */
  draftError?: string;
  runLogs?: Record<string, string>;
  /** Given to each PR `pr create` opens. */
  defaultChecks?: FakePr["checks"];
  defaultMergeable?: string;
  /** Answer of `gh api` on branch protection / rules: true = one required check, "error" = HTTP 500. */
  requiredChecks?: boolean | "error";
  prs: FakePr[];
}

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE ?? "";
const state: State = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { prs: [] };
state.prs ??= [];
const usesStdin = args.includes("--body-file");
const stdin = usesStdin ? await new Response(Bun.stdin.stream()).text() : undefined;
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ args, ...(usesStdin ? { stdin } : {}) })}\n`);

const save = () => statePath && writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
const fail = (msg: string, code = 1): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const find = (ref: string) => {
  const byUrl = state.prs.find((p) => p.url === ref);
  if (byUrl) return byUrl;
  const mine = state.prs.filter((p) => p.head === ref);
  return mine.find((p) => p.state === "OPEN") ?? mine.at(-1);
};
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", state.remote ?? ".", ...a]);
  if (r.exitCode !== 0) fail(`fake gh: git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Sha of the PR head on the bare remote, when there is one and the branch still exists. */
const headSha = (p: FakePr): string | undefined => {
  if (!state.remote) return undefined;
  const r = Bun.spawnSync(["git", "-C", state.remote, "rev-parse", "--verify", "-q", `refs/heads/${p.head}`]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
};

const [cmd, sub] = args;
if (cmd === "--version") {
  out("gh version 2.99.0 (fake)");
  process.exit(0);
}
if (cmd === "auth" && sub === "status") {
  if (state.auth === false) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  out("github.com: Logged in (fake)");
  process.exit(0);
}
if (cmd === "pr" && sub === "view") {
  const pr = find(args[2]);
  if (!pr) fail(`no pull requests found for branch "${args[2]}"`);
  const p = pr as FakePr;
  out(
    JSON.stringify({
      url: p.url,
      number: p.number,
      state: p.state,
      body: p.body,
      mergeable: p.mergeable ?? "MERGEABLE",
      mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
      baseRefName: p.base,
      isDraft: p.isDraft === true,
      ...(headSha(p) ? { headRefOid: headSha(p) } : {}),
    }),
  );
  process.exit(0);
}
if (cmd === "pr" && sub === "create") {
  const head = opt("--head") ?? "";
  const draft = args.includes("--draft");
  if (draft && state.draftError) fail(state.draftError);
  if (state.prs.some((p) => p.head === head && p.state === "OPEN")) fail(`a pull request for branch "${head}" already exists`);
  const number = state.nextNumber ?? state.prs.length + 1;
  state.nextNumber = number + 1;
  const url = `https://github.com/o/r/pull/${number}`;
  state.prs.push({
    number,
    url,
    head,
    base: opt("--base") ?? "",
    title: opt("--title") ?? "",
    body: stdin ?? "",
    state: "OPEN",
    ...(draft ? { isDraft: true } : {}),
    ...(state.defaultChecks ? { checks: state.defaultChecks } : {}),
    ...(state.defaultMergeable ? { mergeable: state.defaultMergeable } : {}),
  });
  save();
  out(`Creating pull request\n${url}`);
  process.exit(0);
}
if (cmd === "pr" && sub === "edit") {
  const pr = find(args[2]) ?? fail("no pull request");
  if (opt("--title") !== undefined) pr.title = opt("--title") as string;
  if (stdin !== undefined) pr.body = stdin;
  save();
  out(pr.url);
  process.exit(0);
}
if (cmd === "pr" && sub === "ready") {
  const pr = find(args[2]) ?? fail(`could not find pull request ${args[2]}`);
  if (pr.state !== "OPEN") fail(`Pull request ${pr.url} is closed`);
  pr.isDraft = args.includes("--undo");
  save();
  out(
    pr.isDraft ? `Pull request o/r#${pr.number} is converted to "draft"` : `Pull request o/r#${pr.number} is marked as "ready for review"`,
  );
  process.exit(0);
}
if (cmd === "pr" && sub === "checks") {
  const pr = find(args[2]) ?? fail("no pull request");
  const onlyRequired = args.includes("--required");
  const checks = (pr.checks ?? []).filter((c) => !onlyRequired || c.required !== false);
  if (checks.length === 0) fail(`no ${onlyRequired ? "required " : ""}checks reported on the '${pr.head}' branch`);
  out(JSON.stringify(checks));
  process.exit(checks.some((c) => c.bucket === "fail") ? 1 : checks.some((c) => c.bucket === "pending") ? 8 : 0);
}
if (cmd === "pr" && sub === "merge") {
  const pr = find(args[2]) ?? fail("no pull request");
  if (args.includes("--disable-auto")) {
    pr.autoMerge = false;
    save();
    out("auto-merge disabled");
    process.exit(0);
  }
  if (state.mergeError) fail(state.mergeError);
  if (pr.isDraft) fail(`Pull request o/r#${pr.number} is still a draft`);
  if (pr.state !== "OPEN") fail(`Pull request ${pr.url} is closed`);
  if (pr.mergeable === "CONFLICTING") fail(`Pull request o/r#${pr.number} is not mergeable: the merge commit cannot be cleanly created.`);
  pr.method = ["--merge", "--squash", "--rebase"].find((m) => args.includes(m))?.slice(2);
  if (args.includes("--auto")) {
    pr.autoMerge = true;
    save();
    out(`Pull request o/r#${pr.number} will be automatically merged when all requirements are met`);
    process.exit(0);
  }
  if (state.remote) {
    const sha = git("rev-parse", `refs/heads/${pr.head}`);
    git("update-ref", `refs/heads/${pr.base}`, sha);
    if (args.includes("--delete-branch")) git("update-ref", "-d", `refs/heads/${pr.head}`);
    pr.mergeCommit = sha;
  }
  pr.state = "MERGED";
  save();
  out(`Merged pull request o/r#${pr.number}`);
  process.exit(0);
}
if (cmd === "api") {
  const path = sub ?? "";
  if (state.requiredChecks === "error") fail("gh: Server Error (HTTP 500)");
  if (/\/protection\/required_status_checks$/.test(path)) {
    if (state.requiredChecks !== true) fail("gh: Branch not protected (HTTP 404)");
    out(JSON.stringify({ strict: false, contexts: ["ci"], checks: [{ context: "ci", app_id: null }] }));
    process.exit(0);
  }
  if (/\/rules\/branches\//.test(path)) {
    out("[]");
    process.exit(0);
  }
}
if (cmd === "run" && sub === "view") {
  const log = state.runLogs?.[args[2]];
  if (log === undefined) fail(`run ${args[2]} not found`);
  out(log as string);
  process.exit(0);
}
fail(`fake gh: unsupported command: ${args.join(" ")}`, 2);
