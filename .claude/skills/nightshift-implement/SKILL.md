---
name: nightshift-implement
description: Implements a Nightshift card from its specification, in its own git worktree. Runs every task itself, in the card's own session, captures result screenshots, and checks the definition of done. Use when a Nightshift skill column implements a specified card.
---

# Nightshift Implement

Take a specified brief and implement every task of the ticket yourself, in order.

The ticket is the card description: the specification from `nightshift-plan` (`## Tasks`, an ordered list), or the grilled brief with `## Acceptance` when grill sent the card straight here (`Route: implement`). Tasks run in the order written.

Do every task yourself, in this session: the next columns may start a fresh session and read only the card and the diff. Never hand a task to a subagent (Agent tool, `claude -p`): what it learns would be lost to this run.

Other implementation cards may run on this repository at the same time. By default this run uses its own git worktree, and you work only there. Nobody edits the shared checkout. The worktree policy in the prompt's `<environment>` block can change that: see step 3.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`) and the board columns. The description is the specification.
- The process starts in the board project, and that directory is a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the git error under `## Result`, and stop.
- Do not push. Do not create a pull request. Unless the worktree policy lets you work in the shared checkout (step 3), do not commit, stage, checkout, or edit it. Another implementation may be using it.

## Steps

1. Read the card. List the tasks in order (`Files`, `Context`, `Hard part`, `Done when`).
   - If the prompt has no card: set `move` to `stay`, ask one question for the specification, and stop.
2. If `## Tasks` is missing and the card does not say `Route: implement`, do not implement. Ask every blocker at once (see Asking questions).
   - When `## Tasks` is missing and the card says `Route: implement`, the card skipped `nightshift-plan`: plan it yourself, briefly, without asking. Add to the description `## Plan` (the approach in a few lines, the files you expect to touch, the risk to watch), `## Progress` with one line `- [ ] 1. <card title>`, and `## Definition of done` built from `## Acceptance` (plus "affected tests pass" and "full suite: deferred to review"). Then implement it as one task, in this run's worktree: no task branch, no task worktree, no merge.
3. Read the worktree policy: the `Worktree policy:` line of the `<environment>` block in the prompt (`required`, `auto` or `forbidden`; no block or no line means `required`). It decides where this run works. Call that place the work directory.
   - `required`: create the worktree below. The work directory is the worktree.
   - `auto`: create the worktree below, except when the change is trivial (documentation only, or a one-line fix) and no other agent runs on this project: the `<environment>` block shows no other card marked `[running]`, and `git worktree list` shows no `nightshift/*` worktree. Then use the shared checkout as in `forbidden`. When in doubt, create the worktree.
   - `forbidden`: no worktree and no `nightshift/<card-id>` branch. The work directory is the board project, on the branch checked out there: record the base as below and commit on that branch directly. Do not switch branches. Leave other pending files alone. `## Result` gets `Worktree: none`, and `nightshift-merge` then only pushes the base.
   - Below, "this run's worktree" means the work directory; the shared-checkout rules apply only when it is a worktree.
   Create this run's worktree before any commit, test, or edit. First record the base: the branch checked out in the shared checkout (`git symbolic-ref --short HEAD`, for example `WIP` or `main`; `detached` on a detached `HEAD`) and its SHA (`git rev-parse HEAD`). `nightshift-merge` merges the card back into it. Branch `nightshift/<card-id>`, directory from `mktemp -d`, then `git worktree add -b nightshift/<card-id> <dir> HEAD`. On failure: delete nothing, then stop (Stop rule). Every command from here runs in that directory. Leave pending files in the shared checkout as they are.
   - Worktree only: when the board project keeps a git-ignored test selection cache (for example `.testmondata` for pytest-testmon), `cp` it (never a link) to the same path in the worktree, so the affected-tests command runs in seconds.
4. In the work directory, commit any pending changes before changing anything. Run `git status --porcelain`. If the output is empty, skip the commit. Otherwise commit those paths (with no worktree, only the files this card is about to touch: leave unrelated pending files alone), except `.env` and credential files, in one commit: `chore: save pending work before implementation`. Do not use `--no-verify` and do not amend. If the hook changes files, add them in a new commit.
5. Do not run the full test suite: it runs once, at the end of `nightshift-review`. Before any implementation, run the affected-tests command (see Tests) once against the base SHA: its failures are the baseline, written under `## Result`. Continue even when some fail; the card must not add new failures.
6. Run every task yourself, in the work directory, in order. No task branch, no task worktree, no task merge, no subagent. Follow Implementation rules below.
   - After each task, check it: the tests that name it in `## Tests` pass, its commits are on `nightshift/<card-id>` (`git log`), and `git status --porcelain` is clean. Then check its line in `## Progress` (`- [ ]` becomes `- [x]`); leave later lines unchecked.
   - A failing check: fix it once, then check again. A second failure of the same check: Stop rule.
7. Run the affected-tests command against the base SHA. Then the items of `## Definition of done` and the tests of `## Tests` it does not cover, except the full suite gate (the project's whole check or test command): write "deferred to review" next to that item. A new failure (not in the baseline): fix it once and re-run; a second failure: Stop rule. Do not commit a red tree.
8. Commit everything still uncommitted, in small modular commits (one cohesive behavior each), never `.env` or credential files. When those commits change code (`git rev-parse HEAD^{tree}` differs from the tree of step 7), re-run the affected tests; a failure follows step 7.
   - Record it: the `Tests` line of `## Result` names the affected-tests command, its exit code and the failing tests (none, or the baseline's). The full suite is not run here: `nightshift-review` runs it.
9. `git status --porcelain` in this run's worktree must be empty except ignored secrets (with no worktree: no file this card changed is left uncommitted). Tick the definition-of-done items that passed. Append `## Result`. Keep this run's worktree, if any. Set `move` to `next` and `questions` to an empty array.
10. Set `test` so a human can try the card from the Nightshift card with one click. See Test command.
11. Capture screenshots of the running result so the human can check them while testing. See Capturing screenshots. On a stop before step 9, skip this step.

Stop rule: set `move` to `stay`, write the command and its output under `## Result`, check only the finished `## Progress` lines, omit `test`, and stop.

## Use the context you were given

The card holds the research: grill and plan wrote the `file:line` references, contracts, commands and decisions. Start from it.

- Trust the card's `Context`, `Architecture` and task sections. Do not re-derive what they state, and do not re-check a decision the card records.
- Read only what a task touches: the referenced lines (`sed -n '<from>,<to>p'`, or Read with an offset), not whole files; the functions you change and their tests. Line numbers may have drifted a little since the card was written: search near them, not across the repository.
- No broad exploration: no repository-wide `grep`/`rg` sweeps, no directory listings, no Explore agent, no reading of docs the card does not point to. Search only when the card leaves a gap you must fill, and then only for that symbol.

## Implementation rules

- Work only in the work directory: this run's worktree on `nightshift/<card-id>`, or the board project when the policy has no worktree. With a worktree, do not read or write the shared checkout.
- Obey the grilled note (the top of the description), the Architecture, the current task and the tests that name it.
- Write the real behavior. No TODO, FIXME, stub, skipped test, or empty body that only throws.
- `Files` lists where a task is expected to land: a guide, not a wall. Touch another file when the task needs it, and say so in `## Result`. Do not reformat or rewrite code the card does not need to change.
- Build on the previous tasks: they are committed in the work directory and you read their code already. Do not re-read what you wrote unless you need a detail.
- Commit as you go, in small modular commits, each only after the tests covering it pass (affected tests, never the full suite). Do not save a whole task for one final commit.
- Do not use `--no-verify` and do not amend. If a hook changes files, add them in a new commit. Do not commit `.env` or credential files.

## Tests

The affected-tests command runs only the tests a change touches since a base commit. It keeps the full suite to a single run, at the end of `nightshift-review`.

- Use the command the column instructions give. Otherwise the one the project declares: a `test:affected` (or similar) script, or the command the README or `CLAUDE.md` names.
- When the project has none, run the project's test runner on the test files that cover the changed files (`git diff --name-only <base sha>`): most runners take file paths or have a related-tests mode (`vitest related`, `jest --findRelatedTests`, `bun test <files>`, `pytest <files>`). Run the full suite only when the runner cannot select tests.
- Write the command you used under `## Result`, so `nightshift-review` and `nightshift-merge` run the same one.

## Test command

Nightshift runs `test.command` with `sh -c` from the board project folder when the human clicks "Tester", and stops its whole process group on "Arrêter". It must run this run's worktree, never the shared checkout.

- Start with `cd <work directory> &&`, then install dependencies when missing with the repo's own installer (`(test -d node_modules || bun install) &&` for Bun), then the repo's start command (`start`/`dev` script, or the README's run command). Column instructions win when they give the command.
- Start a server only when the card changes a screen (`git diff --name-only <base sha>` lists UI code, or the brief names a page), and then everything that screen needs (backend and services, then the front end; see `nightshift-review`'s Run the app). Otherwise (backend, CLI, library, docs) `test.command` is the affected-tests command in the work directory, with no `url`.
- A server listens on a free port, never the default: the first port from the default + 1 for which `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing, passed with the port flag or `PORT=<port>`. Keep browser auto-opening: never pass `--no-open` or similar.
- Set `test.url` (`http://localhost:<port>`) when the command starts a server at a known address.

Also write the command under `## Result` as `- Test: <command>`.

## Capturing screenshots

Only when `test.url` is set. Otherwise write `## Screenshots` with the line `No screen to capture.` and skip the rest: no server, no browser, no `npx playwright`.

1. Start `test.command` in the background with the start command's no-browser flag or variable for this run only (`NIGHTSHIFT_NO_OPEN=1` for Nightshift itself); the stored `test.command` does not change. Retry `curl -sf -o /dev/null <url>` 10 times, one second apart. If it never answers, stop the process, write the error under `## Screenshots`, and continue: a missed screenshot never fails the card.
2. Save one PNG per screen the brief names (else `test.url` once as `01-home.png`) in `<worktree>/nightshift-screenshots/`, numbered `01-slug.png`, `02-slug.png`, from the worktree with `npx --yes playwright screenshot --browser chromium --full-page --viewport-size=1280,800 "<url>" "<png>"`. Retry a failed file once, then write its error under `## Screenshots` and go on.
3. Stop the server you started, so the port is free for the Tester button. Do not stage or commit `nightshift-screenshots`.
4. Append `## Screenshots`: one markdown image per PNG, absolute path, alt text the screen name (`![Home](/abs/path/nightshift-screenshots/01-home.png)`).

## Asking questions

Use this only in step 2, for example: "The card has no `## Tasks` section. Which tasks should be implemented, and in what order? Recommended: move the card back to plan." When an answer is empty in the note and in the resume prompt, do not guess: set `move` to `stay` and stop.

## Writing the result

Append this to the specification. Do not delete `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, or `## Definition of done`. Do not renumber `## Progress`.

```markdown
## Result

- Worktree: <path of this run's worktree, or `none` when the policy had no worktree>
- Branch: nightshift/<card-id> (or, with `Worktree: none`, the base branch the commits are on)
- Base: <branch the card started from, or detached> at <sha>
- Shared checkout: untouched (or, with `Worktree: none`, committed to directly)
- Baseline: pending work commit <sha or "clean">, affected tests → exit <code>, failing: <none, or the tests already failing on the base>
- Model: <the model this run used>; repairs: <n>
- Tasks done: <names, in order>, all done in the card's session (no subagent)
- Files beyond the tasks' `Files`: <paths and why, or none>
- Tests: <affected-tests command> → exit <code>, failing: <none, or the baseline's>; full suite: deferred to review
- Commits: <shas, in order>
- Test: <test command>
- Screenshots: <absolute png paths, or "none">
```

## Output

Done (on a stop: `move` is `stay`, only the finished `## Progress` lines are checked, no `test`):

```json
{
  "title": "current title",
  "sections": [{"heading": "Progress", "content": "…"}, {"heading": "Definition of done", "content": "…ticked…"}, {"heading": "Result", "content": "…"}, {"heading": "Screenshots", "content": "No screen to capture."}],
  "move": "next",
  "summary": "Implemented 3 tasks in the card's session. Definition of done passed.",
  "questions": [],
  "test": { "command": "cd <worktree> && (test -d node_modules || bun install) && bun run dev --port 4546", "url": "http://localhost:4546" }
}
```

## Done when

- [ ] Only the work directory changed: the shared checkout is untouched, or `Worktree: none` says the policy allowed it
- [ ] The baseline was recorded before the first edit, and the full suite was not run
- [ ] Every task ran in this session, in this run's worktree, with no subagent, as small commits; the work directory is clean except ignored secrets
- [ ] `move` is `next` only when the affected tests pass with no failure beyond the baseline
