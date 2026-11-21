---
name: nightshift-implement
description: Implements a Nightshift card from its specification, in its own git worktree. Runs every task itself, in the card's own session, and checks the definition of done. Use when a Nightshift skill column implements a specified card.
---

# Nightshift Implement

Take a specified brief and implement every task of the ticket yourself, in order.

The ticket is the card description: the specification from `nightshift-plan` (`## Tasks`, run in order), or the grilled brief with `## Acceptance` when grill sent the card straight here (`Route: implement`).

Do every task yourself, in this session. Never hand a task to a subagent (Agent tool, `claude -p`): what it learns would be lost.

Other cards may run on this repository at the same time, so by default this run works only in its own git worktree and nobody edits the shared checkout. The worktree policy can change that: see step 3.

## Prerequisites

- The worker prompt contains the card (`<title>`, `<description>`, `id`); the description is the specification.
- The process starts in the board project, a git repository (`git rev-parse --is-inside-work-tree`). If that fails, set `move` to `stay`, write the error under `## Result`, and stop.
- Do not push or open a PR (Nightshift does). Unless the policy lets you work in the shared checkout (step 3), do not commit, stage, checkout, or edit it.

## Steps

1. Read the card. List the tasks in order.
   - No card in the prompt: set `move` to `stay`, ask one question for the specification, and stop.
2. If `## Tasks` is missing and the card does not say `Route: implement`, do not implement. Ask every blocker at once (see Asking questions).
   - When `## Tasks` is missing and the card says `Route: implement`, the card skipped `nightshift-plan`: plan it yourself, briefly, without asking. Add `## Plan` (approach, expected files, risk), `## Progress` with one line `- [ ] 1. <card title>`, and `## Definition of done` built from `## Acceptance` (plus "affected tests pass" and "full suite: deferred to review"). Implement it as one task, with no task branch or task worktree.
3. Read the worktree policy: the `Worktree policy:` line of the `<environment>` block in the prompt (`required`, `auto` or `forbidden`; no line means `required`). It decides the work directory.
   - `required` (the default): create the worktree below. The work directory is the worktree.
   - `auto` or `forbidden`: read references/no-worktree.md first; it may let you work in the shared checkout.
   Create the worktree before any commit, test or edit. First record the base: the branch checked out in the shared checkout (`git symbolic-ref --short HEAD`, for example `WIP` or `main`; `detached` on a detached `HEAD`) and its SHA (`git rev-parse HEAD`). Branch `nightshift/<card-id>`, directory from `mktemp -d`, then `git worktree add -b nightshift/<card-id> <dir> HEAD`. On failure: delete nothing, Stop rule. Every command from here runs in that directory; leave pending files in the shared checkout alone.
   - Worktree only: `cp` (never link) a git-ignored test selection cache (for example `.testmondata`) to the same path in the worktree.
4. In the work directory, commit any pending changes before changing anything. Run `git status --porcelain`. If the output is empty, skip the commit. Otherwise commit those paths (with no worktree, only the files this card is about to touch: leave unrelated pending files alone), except `.env` and credential files, in one commit: `chore: save pending work before implementation`. Never `--no-verify`, never amend.
5. Never run the full suite (`nightshift-review` does, once). No base run before implementing: see step 7.
6. Run every task in order in the work directory, following Implementation rules below.
   - After each task, check it: the tests that name it in `## Tests` pass, its commits are on `nightshift/<card-id>` (`git log`), and `git status --porcelain` is clean. Then tick its line in `## Progress`.
   - A failing check: fix it once; a second failure: Stop rule.
7. Run the affected-tests command (see Tests) on the work directory. When some fail, re-run only those on the base SHA in a throwaway detached worktree (detached, same links, removed after): those failing there too are the baseline. All pass: base not run. Then the items of `## Definition of done` and the tests of `## Tests` it does not cover, except the full suite gate (the project's whole check or test command): write "deferred to review" next to that item. A new failure (not failing on the base): fix it once and re-run; a second failure: Stop rule. No red commit.
8. Commit everything still uncommitted, in small modular commits (one cohesive behavior each), never `.env` or credential files. When those commits change code (`git rev-parse HEAD^{tree}` differs from the tree of step 7), re-run the affected tests; a failure follows step 7.
9. `git status --porcelain` in this run's worktree must be empty except ignored secrets (with no worktree: no file this card changed is left uncommitted). Tick the definition-of-done items that passed. Append `## Result`. Keep this run's worktree, if any. Set `move` to `next` and `questions` to an empty array.
10. Set `test` so a human can try the card with one click (see Test command).
11. Capture screenshots (see Screenshots). Skip on a stop.

Stop rule: set `move` to `stay`, write the command and its output under `## Result`, check only the finished `## Progress` lines, omit `test`, and stop.

## Use the context you were given

The card holds the research (`file:line` references, contracts, commands, decisions). Trust it: do not re-derive what it states or re-check a decision it records.

- Read only what a task touches: the referenced lines, the functions you change and their tests.
- No broad exploration (no repository-wide sweeps, directory listings or Explore agent). Search only for a symbol the card leaves a gap on.

## Implementation rules

- Work only in the work directory: this run's worktree on `nightshift/<card-id>`, or the board project when the policy has no worktree. With a worktree, do not read or write the shared checkout.
- Obey the grilled note, the Architecture, the current task and the tests that name it.
- Write the real behavior: no TODO, FIXME, stub or skipped test.
- `Files` is a guide, not a wall: touch another file when the task needs it, and say so in `## Result`. Do not reformat code the card does not need to change.
- Commit as you go, in small modular commits, each only after the tests covering it pass (affected tests, never the full suite). Do not save a whole task for one final commit.
- Never `--no-verify`, never amend (a hook's changes go in a new commit), never commit `.env` or credentials.

## Tests

- Use the command the column instructions give, else the project's own (a `test:affected` script, or what the README or `CLAUDE.md` names).
- When the project has none, run its test runner on the test files that cover the changed files (`git diff --name-only <base sha>`; for example `bun test <files>`, `pytest <files>`). Run the full suite only when the runner cannot select tests.
- Write the command you used under `## Result`, so `nightshift-review` and `nightshift-merge` run the same one.

## Test command

`test.command` runs with `sh -c` from the board project folder on "Tester". It must run this run's worktree.

- The card changes a screen (`git diff --name-only <base sha>` lists UI code, or the brief names a page): read references/ui-cards.md for the stack, the command and `test.url`.
- Otherwise (backend, CLI, library, docs) `test.command` is the affected-tests command in the work directory (`cd <work directory> && …`, install first if needed), with no `url`. No server, no browser, no `npx playwright`.

Also write the command under `## Result` as `- Test: <command>`.

## Screenshots

Only when `test.url` is set and no `nightshift-review` column remains in `Card path` (see references/ui-cards.md): the card skips Review. When Review remains, start no app and write `## Screenshots` as `Deferred to review.`. With no `test.url`: `No screen to capture.`.

## Asking questions

Only in step 2, for example: "The card has no `## Tasks` section. Which tasks should be implemented? Recommended: move the card back to plan." An empty answer: set `move` to `stay` and stop, never guess.

## Writing the result

Append this to the specification. Do not delete `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, or `## Definition of done`. Do not renumber `## Progress`.

```markdown
## Result

- Worktree: <path, or `none`>
- Branch: nightshift/<card-id> (with `Worktree: none`, the base branch)
- Base: <branch, or detached> at <sha>
- Shared checkout: untouched (or committed to directly)
- Baseline: pending work commit <sha or "clean">, base not run (tests pass) or base run on <tests>, failing: <none, or those failing on the base>
- Model: <the model this run used>; repairs: <n>
- Tasks done: <names, in order>, all done in the card's session
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
  "test": { "command": "cd <worktree> && bun run dev --port 4546", "url": "http://localhost:4546" }
}
```

## Done when

- [ ] Only the work directory changed: the shared checkout is untouched, or `Worktree: none` says the policy allowed it
- [ ] No test ran on the base unless one failed after the change, and the full suite was not run
- [ ] Every task ran in this session, in this run's worktree, with no subagent, as small commits; the work directory is clean except ignored secrets
- [ ] `move` is `next` only when the affected tests pass with no failure beyond the baseline
