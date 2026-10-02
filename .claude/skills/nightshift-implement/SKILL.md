---
name: nightshift-implement
description: Implements a Nightshift card from its specification, in its own git worktree. Runs every task itself, in the card's own session, captures result screenshots, and checks the definition of done. Use when a Nightshift skill column implements a specified card.
---

# Nightshift Implement

Take a specified brief and implement every task of the ticket yourself, in order.

The ticket is the card description: the specification from `nightshift-plan`, with `## Tasks` waves. Tasks run in wave order, then in task order inside the wave. `parallel` in a wave heading only says the tasks are independent: they still run one after another.

Nightshift runs a column in one Claude session per card, and a column may start a fresh one (the default for new columns), so the next columns read the card and the diff rather than this context. Do the work yourself so that context stays within this run. Never hand a task to a subagent (Agent tool, `claude -p`): what it learns would be lost to this run.

Other implementation cards may run on this repository at the same time. This run uses its own git worktree, and you work only there. Nobody edits the shared checkout.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`) and the board columns. The description is the specification.
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`, `test`). Do not edit `nightshift.json`.
- Do not call `AskUserQuestion`.
- The process starts in the board project, and that directory is a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the git error under `## Result`, and stop.
- Do not push. Do not create a pull request. Do not commit, stage, checkout, or edit the shared checkout. Another implementation may be using it.

## Steps

Progress marker: at the start of each step, write `[nightshift-progress] N/M label` alone on its own line, where N is the current step number, M is the total, and label is a few words naming the step. Use the numbering of the card's `## Progress` list; when the card has none, use the numbering of this `## Steps` list. A machine reads this line, so it overrides any concise or no-narration style.

1. Read the card. List every wave in order, and every task under it (`Owns`, `Hard part`, `Done when`, `Depends on`).
   - If the prompt has no card: set `move` to `stay`, ask one question for the specification, and stop.
2. If `## Tasks` is missing and the card does not say `Route: implement`, do not implement. Ask every blocker at once. See Questions.
   - When `## Tasks` is missing and the card says `Route: implement`, the card skipped `nightshift-plan`: plan it yourself, briefly, without asking. Add to the description `## Plan` (the approach in a few lines, the files you expect to touch, the risk to watch), `## Progress` with one line `- [ ] 1. <card title>`, and `## Definition of done` built from `## Acceptance` (plus "affected tests pass" and "full suite: deferred to review"). Then implement it as one task, in this run's worktree: no task branch, no task worktree, no merge.
3. Create this run's worktree before any commit, test, or edit. First record the base: the branch checked out in the shared checkout (`git symbolic-ref --short HEAD`, for example `WIP` or `main`) and its SHA (`git rev-parse HEAD`). On a detached `HEAD`, the base is `detached`. The card starts from that branch and `nightshift-merge` merges it back into it. Branch `nightshift/<card-id>`, directory from `mktemp -d`, then `git worktree add -b nightshift/<card-id> <dir> HEAD`. On failure: delete nothing, write the command and the error under `## Result`, set `move` to `stay`, and stop. Every command from here runs in that directory. Leave pending files in the shared checkout as they are.
   - Seed the test selection cache: when the board project keeps one that git ignores (for example `.testmondata` for pytest-testmon), copy it to the same path in the worktree (`cp`, never a link). It tells the runner which tests each piece of code runs, so the affected-tests command runs in seconds instead of running everything.
4. In the worktree, commit any pending changes before changing anything. Run `git status --porcelain`. If the output is empty, skip the commit. Otherwise commit those paths, except `.env` and credential files, in one commit: `chore: save pending work before implementation`. Do not use `--no-verify` and do not amend. If the hook changes files, add them in a new commit.
5. Do not run the full test suite: it runs once, at the end of `nightshift-review`. Record the starting point instead: run the affected-tests command (see Tests) once, against the base SHA, before any implementation. With no change yet it runs only the tests that already fail on the base, or the tests of the area the card touches: their failures are the baseline, written under `## Result`. Continue even when some fail; the card must not add new failures.
6. Run every task yourself, in this run's worktree, in wave order. No task branch, no task worktree, no task merge, no subagent. Follow Implementation rules below.
   - After each task, check it: the tests that name it in `## Tests` pass, its commits are on `nightshift/<card-id>` (`git log`), and `git status --porcelain` is clean. Then check its line in `## Progress` (`- [ ]` becomes `- [x]`) and start the next task. Leave every later line unchecked. On a stop, return the description with only the finished lines checked.
   - A failing check: fix it once, then check again. A second failure of the same check: set `move` to `stay`, write the command and the output under `## Result`, and stop.
7. Run the affected-tests command (see Tests) in this run's worktree, against the base SHA. Then the items of `## Definition of done` and the tests of `## Tests` that this command does not cover, except the full suite gate (the project's whole check or test command): write "deferred to review" next to that item instead of running it. A new failure (not in the baseline of step 5): fix it once, then re-run the affected tests. A second failure of that check: set `move` to `stay`, write the command and the output under `## Result`, and stop. Do not commit a red tree.
8. In this run's worktree, commit everything still uncommitted, in small modular commits: one cohesive behavior per commit, not one commit for the whole tree. Do not stage `.env` or credential files. When those commits change code (`git rev-parse HEAD^{tree}` differs from the tree of step 7), re-run the affected tests; a failure follows step 7.
   - Record it: the `Tests` line of `## Result` names the affected-tests command, its exit code and the failing tests (none, or the baseline's). The full suite is not run here: `nightshift-review` runs it.
9. `git status --porcelain` in this run's worktree must be empty except ignored secrets. The shared checkout must be unchanged by this run. Tick the definition-of-done items that passed. Append `## Result`. Keep this run's worktree. Set `move` to `next` and `questions` to an empty array.
10. Set `test` so a human can try the card from the Nightshift card with one click. See Test command.
11. Capture screenshots of the running result so the human can check them while testing. See Screenshots. On a stop before step 9, skip this step.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Implementation rules

- Work only in this run's worktree, on `nightshift/<card-id>`. Do not read or write the shared checkout.
- Obey the Brief, the Architecture, the current task and the tests that name it.
- Write the real behavior. No TODO, FIXME, stub, skipped test, or empty body that only throws.
- Owns is a guide. Stay inside the task's Owns by default. Edit another path only when the task cannot be done otherwise, and list it under `## Result`. Never reformat or rewrite unrelated files.
- Commit as you go, in small modular commits: one cohesive behavior per commit. Do not save a whole task for a single commit at the end.
- Commit only after the tests that cover that behavior pass. Run only those tests: the affected-tests command (see Tests), or the project's test runner on your test files. Never the full suite: it runs once at the end of the review.
- Do not use `--no-verify` and do not amend. If a hook changes files, add them in a new commit. Do not commit `.env` or credential files.
- The `Model:` lines of the tasks do not switch your model: one session runs on one model, the column's or the card's (`nightshift-plan` sets the card's models). Read them as how careful each task needs to be.

## Tests

The affected-tests command runs only the tests a change touches since a base commit. It keeps the full suite to a single run, at the end of `nightshift-review`.

- Use the command the column instructions give. Otherwise the one the project declares: a `test:affected` (or similar) script, or the command the README or `CLAUDE.md` names.
- When the project has none, run the project's test runner on the test files that cover the changed files (`git diff --name-only <base sha>`): most runners take file paths or have a related-tests mode (`vitest related`, `jest --findRelatedTests`, `bun test <files>`, `pytest <files>`). Run the full suite only when the runner cannot select tests.
- Write the command you used under `## Result`, so `nightshift-review` and `nightshift-merge` run the same one.

## Test command

Nightshift runs `test.command` with `sh -c` from the board project folder when the human clicks "Tester", and stops its whole process group on "Arrêter". Build it so it runs this run's worktree, never the shared checkout.

- Start with `cd <worktree path> &&`.
- Install dependencies when the worktree has none, with the repo's own installer: `(test -d node_modules || bun install) &&` for a Bun repo, and the matching command for other package managers.
- Then run the repo's start command: the `start` or `dev` script in `package.json`, or the run command in the README. Follow column instructions when they give the command.
- Start a server only when the card changes a screen: `git diff --name-only <base sha>` lists UI code, or the brief names a page. Then the start command runs everything that screen needs (its backend and services, then the front end), never a front-end dev server alone: follow `nightshift-review`'s Run the app.
- A card that changes no screen (backend, CLI, library, deploy, docs): no server and no `test.url`. Set `test.command` to the affected-tests command run in the worktree.
- A server must listen on a free port, never the project's default port. Pick one with `lsof -nP -iTCP:<port> -sTCP:LISTEN` returning nothing, starting at the default port + 1. Pass it with the start command's port flag or `PORT=<port>`. Keep the start command's browser auto-opening: never pass `--no-open` or a similar flag, so the human lands on the right page.
- Set `test.url` to the address the human opens (`http://localhost:<port>`) when the command starts a server and that address is known in advance. Omit `url` otherwise.
- When nothing can be run (library, docs only), set `test.command` to the affected-tests command run in the worktree.
- On a stop before step 9, omit `test`.

Example:

```json
{
  "command": "cd <worktree path> && (test -d node_modules || bun install) && bun bin/app.ts --port 4546",
  "url": "http://localhost:4546"
}
```

Also write the command under `## Result` as `- Test: <command>`.

## Screenshots

Do this only after step 10, and only when `test.url` is set, which means the card changed a screen (Test command). Any other card has no screen: write `## Screenshots` with the line `No screen to capture.` and skip the rest: no server, no browser, no `npx playwright`.

1. Start `test.command` in the background without opening a browser for the human: add the start command's no-browser flag or environment variable to this run only (`NIGHTSHIFT_NO_OPEN=1` for Nightshift itself). Do not change the stored `test.command`. Wait until `test.url` answers. Retry `curl -sf -o /dev/null <url>` 10 times, one second apart. If it never answers, stop the process, write the error under `## Screenshots`, and continue. Do not fail the card for a missed screenshot.
2. Save one PNG per screen the brief names, in `<worktree>/nightshift-screenshots/`, numbered `01-slug.png`, `02-slug.png`. When the brief names no separate screen, capture `test.url` once as `01-home.png`.
3. Default command, from the worktree:

```bash
npx --yes playwright screenshot --browser chromium --full-page --viewport-size=1280,800 "<url>" "<png>"
```

   On failure, retry that file once. If it still fails, write the error under `## Screenshots` and continue with the files that succeeded.
4. Stop the server you started. Leave the port free for the Tester button.
5. Do not stage or commit `nightshift-screenshots`.
6. Append `## Screenshots` to the description. One markdown image per PNG. The path is absolute. Alt text is the screen name.

```markdown
## Screenshots

![Home](/absolute/path/nightshift-screenshots/01-home.png)
```

## Questions

Use this only in step 2. Ask in two places, same questions, same order. Under each question in the note, leave exactly three blank lines.

```markdown
## Questions

1. The card has no `## Tasks` section. Which tasks should be implemented, and in what order? Recommended: move the card back to plan.



```

On the next run, the answer is the text under that question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use it. When both are empty, do not guess: set `move` to `stay` and stop.

## Result

Append this to the specification. Do not delete `## Brief`, `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, or `## Definition of done`. Do not renumber `## Progress`.

```markdown
## Result

- Worktree: <path of this run's worktree>
- Branch: nightshift/<card-id>
- Base: <branch the card started from, or detached> at <sha>
- Shared checkout: untouched
- Baseline: pending work commit <sha or "clean">, affected tests → exit <code>, failing: <none, or the tests already failing on the base>
- Waves: <n> (<n> tasks), all done in the card's session
- Model: <the model this run used>; repairs: <n>
- Tasks done: <names, in order>
- Tests: <affected-tests command> → exit <code>, failing: <none, or the baseline's>; full suite: deferred to review
- Commits: <shas, in order>
- Test: <test command>
- Screenshots: <absolute png paths, or "none">
```

## Output

Blocked or failed (`questions` empty unless step 2 asked):

```json
{
  "title": "current title",
  "description": "the specification plus ## Result",
  "move": "stay",
  "summary": "Stopped: wave 1 task 2 failed its test twice.",
  "questions": []
}
```

Done:

```json
{
  "title": "current title",
  "description": "the specification plus ## Result, definition of done ticked",
  "move": "next",
  "summary": "Implemented 3 tasks in the card's session. Definition of done passed.",
  "questions": [],
  "test": { "command": "cd <worktree> && (test -d node_modules || bun install) && bun run dev --port 4546", "url": "http://localhost:4546" }
}
```

## Done when

- [ ] This run used one worktree, and the shared checkout was not edited
- [ ] The baseline (affected tests on the untouched worktree) was recorded before the first implementation edit, and the full suite was not run
- [ ] Pending changes inside that worktree were committed before that edit
- [ ] Implementation landed as small modular commits, and that worktree is clean except ignored secrets
- [ ] The affected tests passed after the last commit, with no failure beyond the baseline
- [ ] Every task ran in this session, in this run's worktree, with no subagent
- [ ] `test.command` runs this run's worktree on a free port, and `test.url` is set when it starts a server
- [ ] `## Screenshots` lists one image per captured screen, or says there is no screen to capture
- [ ] `move` is `next` only when those checks passed
