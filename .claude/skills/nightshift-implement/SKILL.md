---
name: nightshift-implement
description: Implements a Nightshift card from its specification, in its own git worktree. Launches one agent per parallel task, captures result screenshots, and checks the definition of done. Use when a Nightshift skill column implements a specified card.
---

# Nightshift Implement

Take a specified brief and implement it using as many parallel agents as specified in the ticket.

The ticket is the card description: the specification from `nightshift-plan`, with `## Tasks` waves. A wave whose heading contains `parallel` gets one agent per task in that wave, all started together. A `sequential` wave gets one agent at a time. Do not add agents. Do not collapse a parallel wave into one agent.

You are the orchestrator. Other implementation cards may run on this repository at the same time. This run uses its own git worktree. Task agents each use another worktree. Nobody edits the shared checkout.

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
2. If a parallel task has no `Owns`, or two tasks in the same parallel wave list the same path, do not implement. Ask every blocker at once. See Questions.
   - When `## Tasks` is missing, the card skipped `nightshift-plan` (grill's `Route: implement`): plan it yourself, briefly, without asking. Add to the description `## Plan` (the approach in a few lines, the files you expect to touch, the risk to watch), `## Progress` with one line `- [ ] 1. <card title>`, and `## Definition of done` built from `## Acceptance` (plus "affected tests pass" and "full suite: deferred to review"). Then implement it as one sequential task **yourself, in this run's worktree**: no task branch, no task worktree, no merge. When the work is above your model (see `nightshift-plan`'s Models: an `opus` kind of task while you run a smaller model), launch one agent with `opus` in this run's worktree instead.
3. Create this run's worktree before any commit, test, or edit. First record the base: the branch checked out in the shared checkout (`git symbolic-ref --short HEAD`, for example `WIP` or `main`) and its SHA (`git rev-parse HEAD`). On a detached `HEAD`, the base is `detached`. The card starts from that branch and `nightshift-merge` merges it back into it. Branch `nightshift/<card-id>`, directory from `mktemp -d`, then `git worktree add -b nightshift/<card-id> <dir> HEAD`. On failure: delete nothing, write the command and the error under `## Result`, set `move` to `stay`, and stop. Every command from here runs in that directory. Leave pending files in the shared checkout as they are.
   - Seed the test selection cache: when the board project keeps one that git ignores (for example `.testmondata` for pytest-testmon), copy it to the same path in the worktree (`cp`, never a link). It tells the runner which tests each piece of code runs, so the affected-tests command runs in seconds instead of running everything.
4. In the worktree, commit any pending changes before changing anything. Run `git status --porcelain`. If the output is empty, skip the commit. Otherwise commit those paths, except `.env` and credential files, in one commit: `chore: save pending work before implementation`. Do not use `--no-verify` and do not amend. If the hook changes files, add them in a new commit.
5. Do not run the full test suite: it runs once, at the end of `nightshift-review`. Record the starting point instead: run the affected-tests command (see Tests) once, against the base SHA, before any implementation. With no change yet it runs only the tests that already fail on the base, or the tests of the area the card touches: their failures are the baseline, written under `## Result`. Continue even when some fail; the card must not add new failures.
6. For each wave, in order:
   - Create one branch `nightshift/<card-id>/<task-slug>` and one worktree outside the repository (`mktemp -d`, then `git worktree add -b <branch> <dir> nightshift/<card-id>`). The task agent works only in that directory. On failure: delete nothing, write the command and the error under `## Result`, set `move` to `stay`, and stop.
   - Start the agents for this wave. Parallel: every task in one step, before any of them returns. Sequential: the next task starts only after the previous task's agent has returned and its checks passed.
   - Wait for the wave. From this run's worktree, merge each task branch into `nightshift/<card-id>` in task order (`git merge --no-edit`). On a conflict, keep the file for the task whose `Owns` lists it. If neither task owns the file, keep both unique hunks and do not drop tests.
   - After a task merges, check its line in `## Progress` (`- [ ]` becomes `- [x]`). Leave every later line unchecked. On a stop, return the description with only the merged lines checked.
   - Remove the task worktree (`git worktree remove`) only after that branch is merged. On a failed task, leave the worktree and record its path.
7. Run the affected-tests command (see Tests) in this run's worktree, against the base SHA. Then the items of `## Definition of done` and the tests of `## Tests` that this command does not cover, except the full suite gate (the project's whole check or test command): write "deferred to review" next to that item instead of running it. A new failure (not in the baseline of step 5): repair once with a new agent in that task's worktree, merge again, re-run the affected tests. A second failure: set `move` to `stay`, write the command and the output under `## Result`, and stop. Do not commit a red tree.
8. In this run's worktree, commit everything still uncommitted, in small modular commits: one cohesive behavior per commit, not one commit for the whole tree. Do not stage `.env` or credential files. When those commits change code (`git rev-parse HEAD^{tree}` differs from the tree of step 7), re-run the affected tests; a failure follows step 7.
   - Record it: the `Tests` line of `## Result` names the affected-tests command, its exit code and the failing tests (none, or the baseline's). The full suite is not run here: `nightshift-review` runs it.
9. `git status --porcelain` in this run's worktree must be empty except ignored secrets. The shared checkout must be unchanged by this run. Tick the definition-of-done items that passed. Append `## Result`. Keep this run's worktree. Set `move` to `next` and `questions` to an empty array.
10. Set `test` so a human can try the card from the Nightshift card with one click. See Test command.
11. Capture screenshots of the running result so the human can check them while testing. See Screenshots. On a stop before step 9, skip this step.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Agent prompt

Paste this to each agent. Fill the bracketed lines. One task per agent.

```text
Implement only the task below. Do not talk to the user. Do not ask questions. Do not edit nightshift.json, skills, or files outside Owns.

Worktree: [path]
Branch: [branch]
Affected-tests command: [the command from Tests]
Specification sections to obey: Brief, Architecture, this task, and the tests that name this task.

Task:
[paste the task, including Owns, Hard part, Done when]

Tests:
[paste only the tests that cover this task]

Rules:
- Write the real behavior. No TODO, FIXME, stub, skipped test, or empty body that only throws.
- Stay inside Owns. Do not reformat or rewrite a file you do not own.
- Commit as you go, in small modular commits: one cohesive behavior per commit, only owned files. Do not save the whole task for a single commit at the end.
- Work only in the worktree path above. Do not read or write the shared checkout.
- Commit only after the tests that cover that behavior pass. Run only those tests: the affected-tests command above, or the project's test runner on your test files. Never the full suite: it runs once at the end of the review.
- Do not use --no-verify and do not amend. If the hook changes files, add them in a new commit. Do not commit .env or credential files.
Return: branch, commit SHAs, paths written, commands run, exit codes.
If a check still fails, return the command and the error. Do not leave a failing commit.
```

Launch each agent with the model on its task's `Model:` line (`haiku`, `sonnet` or `opus`: the Agent tool's `model` parameter, or `--model` for `claude -p`). A task without a `Model:` line gets `sonnet`. A repair agent (step 7) uses the next model up (`haiku` → `sonnet` → `opus`). Your own model, the orchestrator's, comes from the column or the card; do not change it.

Launch agents with the host subagent tool (Agent in Claude Code). On a missing tool: run one `claude -p` per worktree, all of them in the background for a parallel wave, and wait for every process. If a process exits without a result, retry that task once. A second failure follows step 7. The repair agent uses the task worktree, not the shared checkout.

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

1. Two tasks in the same parallel wave own the shared types module. Which task keeps it? Recommended: move the card back to plan — parallel tasks must not share a module.



```

On the next run, the answer is the text under that question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use it. When both are empty, do not guess a shared path: set `move` to `stay` and stop.

## Result

Append this to the specification. Do not delete `## Brief`, `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, or `## Definition of done`. Do not renumber `## Progress`.

```markdown
## Result

- Worktree: <path of this run's worktree>
- Branch: nightshift/<card-id>
- Base: <branch the card started from, or detached> at <sha>
- Shared checkout: untouched
- Baseline: pending work commit <sha or "clean">, affected tests → exit <code>, failing: <none, or the tests already failing on the base>
- Waves: <n> sequential, <n> parallel (<n> agents in the largest wave)
- Models: <task → model, in order; repairs marked>
- Tasks merged: <names, in order>
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
  "summary": "Implemented 3 tasks with 2 parallel agents. Definition of done passed.",
  "questions": [],
  "test": { "command": "cd <worktree> && (test -d node_modules || bun install) && bun run dev --port 4546", "url": "http://localhost:4546" }
}
```

## Done when

- [ ] This run and every task agent used a worktree, and the shared checkout was not edited
- [ ] The baseline (affected tests on the untouched worktree) was recorded before the first implementation edit, and the full suite was not run
- [ ] Pending changes inside that worktree were committed before that edit
- [ ] Implementation landed as small modular commits, and that worktree is clean except ignored secrets
- [ ] The affected tests passed after the last commit, with no failure beyond the baseline
- [ ] Agent count in each parallel wave equals the task count in that wave
- [ ] `test.command` runs this run's worktree on a free port, and `test.url` is set when it starts a server
- [ ] `## Screenshots` lists one image per captured screen, or says there is no screen to capture
- [ ] `move` is `next` only when those checks passed
