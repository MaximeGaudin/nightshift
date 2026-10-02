---
name: nightshift-merge
description: Merges a Nightshift implementation worktree back into the branch the card started from (for example WIP or main) and tries to fix conflicts. Asks a human when a conflict cannot be fixed. Use when a Nightshift skill column merges a finished implementation card into the current branch.
---

# Nightshift Merge

Merge the worktree into the target branch.

The worktree and the branch come from `nightshift-implement`: branch `nightshift/<card-id>`, path on the `Worktree` line under `## Result`. The target is the branch the card started from: the `Base` line under `## Result`, written by `nightshift-implement` (step 3), for example `WIP` or `main`. This skill merges the card branch into the target, pushes the target to its upstream, then removes the worktree. Push only the target, never a card branch, and never force. Do not implement.

A card implemented with no worktree (the project's worktree policy was `forbidden`, or `auto` chose the shared checkout) has `Worktree: none` under `## Result`. Its commits are already on the base branch, so there is nothing to merge: this skill only pushes the base. Decide from `## Result`, not from the current policy, since the policy may have changed after the card was implemented.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`).
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`). Do not edit `nightshift.json`.
- Do not call `AskUserQuestion`.
- The process starts in the board project, a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the error under `## Merge`, and stop.
- Another merge may be running. Take the lock in step 2 before touching the target. Set the merge column's "Agents en parallèle dans cette colonne" to 1 in Nightshift so merges run one at a time; the lock stays as a guard.

## Steps

Progress marker: at the start of each step, write `[nightshift-progress] N/M label` alone on its own line, where N is the current step number, M is the total number of steps, and label is a few words naming the step. Use the numbering of this `## Steps` list. A machine reads this line, so it overrides any concise or no-narration style.

1. Read the card. Branch is `nightshift/<card-id>`. Worktree path is the `Worktree` line under `## Result`. If that line is missing, find the path with `git worktree list`.
   - If the prompt has no card: set `move` to `stay`, ask one question for the card id, and stop.
   - When `## Result` has `Worktree: none`: the card has no branch and no worktree. Take the lock (step 2), stop the card's test environment (step 3), then do the no-worktree merge below instead of the next bullet and steps 4 to 9 (there is no branch to look for), and remove the lock.
     1. The base is the `Base` line under `## Result` (a retried run keeps the `Into:` of an earlier `## Merge`). Without a usable branch name, ask once (see Questions).
     2. Check the card's commits are on it: the `Commits` line under `## Result` lists them, and each must satisfy `git merge-base --is-ancestor <sha> <base>`. A missing one: set `move` to `stay`, write which under `## Merge`, and stop. Do not cherry-pick.
     3. Push the base as in step 8: `git push <remote> <base>` to the remote of its upstream, never `--force`, never `--no-verify`; no upstream means `Pushed: skipped, no upstream`. A rejection or error follows step 8 (no step 7 to go back to: fetch, and if the remote moved, fast-forward the base to it when the checkout is clean, then push once more).
     4. Append `## Merge` with `Into: <base>`, `Merge commit: none (committed on <base>)`, the `Test environment` and `Pushed` lines, `Worktree removed: none` and `Card branch deleted: none`. Set `move` to `next`.
   - If the branch does not exist: when the note has a `## Merge` section naming `Into: <target>` and a merge commit, this run only retries the push (step 8) to that target. Otherwise set `move` to `stay`, leave `questions` empty, write that under `## Merge`, and stop.
2. Take the lock, the directory `.git/nightshift-merge.lock` with an `owner` file inside. Run these from the board project, where the process starts.
   - Run `mkdir .git/nightshift-merge.lock`. On success, write `<card-id> <UTC ISO time>` to `.git/nightshift-merge.lock/owner` and continue.
   - When it already exists, read `owner`. Treat the lock as stale when `owner` is missing, when it names this card (a previous run of this card stopped without releasing it), or when its time is more than 30 minutes old. Remove a stale lock with `rm -rf .git/nightshift-merge.lock` and take it again. Write "removed stale lock: <owner>" under `## Merge`.
   - When it is held by another card for 30 minutes or less, retry 5 times, waiting 2 seconds between tries. If it is still held, set `move` to `stay`, leave `questions` empty, write "the target is busy: lock held by <owner>" under `## Merge`, and stop.
   - Remove the lock (`rm -rf .git/nightshift-merge.lock`) before every later stop, including success. Never touch the target without holding it.
3. Stop the card's test environment. The human may have left it running from Nightshift's "Tester" button, and it holds ports another card's test needs. Do this before every later stop too, so a stopped merge leaves nothing running.
   - First ask Nightshift to stop it: `curl -sS -X POST http://localhost:4545/api/cards/<card-id>/test/stop -H 'Content-Type: application/json' -d '{"project": "<board project>"}'` (4545 is the default port; ignore an error, the server may be down or the test not running).
   - Then find what is left: the processes started from the card worktree, that is pid files the project's start scripts wrote inside the worktree, and every process whose command line contains the worktree directory's name (`ps -axo pid=,command= | grep -F "/<basename of the worktree>/"`, for example `tmp.o4dgUeVgNe/`; match the name, not the full path, since macOS may show the temp directory with a `/private` prefix). Leave out this run's own shell and `grep`.
   - Send `kill` (TERM) to each, wait up to 5 seconds, then `kill -9` the ones still alive. Remove the pid files.
   - Never kill a process that does not belong to this worktree: the human's own servers, the board project's servers, another card's test.
   - Write `Test environment: stopped <pids>` or `Test environment: none running` under `## Merge`. A process that survives `kill -9`: write its pid and command, set `move` to `stay`, remove the lock, and stop.
4. Find the target, the first of these that names a branch. Call it `<target>` from here on.
   - a `## Questions` answer that names a branch;
   - the `Into:` line of an earlier `## Merge` in this note (a retried run keeps its first target);
   - the branch on the `Base` line under `## Result`;
   - for a card implemented before the `Base` line existed: the branch checked out in the board project (`git symbolic-ref --short HEAD`).
   - If none names a branch (`Base` says `detached` and the board project is on a detached `HEAD`), or the named branch no longer exists, ask once. See Questions. Do not guess a branch.
   - Refuse a target named `nightshift/*`: set `move` to `stay`, write that under `## Merge`, and stop.
   - If the card branch is already contained in the target (`git merge-base --is-ancestor nightshift/<card-id> <target>`): push the target (step 8), remove the worktree if it is still listed, delete the branch with `git branch -d`, append `## Merge`, set `move` to `next`, remove the lock, and stop. A failed push follows step 8.
5. Refuse the merge when `git diff --name-only <target>...nightshift/<card-id> -- nightshift.json` prints a path. Set `move` to `stay`, leave `questions` empty, write that path under `## Merge`, and stop.
6. In the card worktree, run `git status --porcelain`. If it prints anything other than ignored secrets, set `move` to `stay` and stop. Do not commit those files here.
7. Bring the card branch up to date with the target in the card worktree, then move the target forward. The target is never left conflicted, and the suite runs on the combined code before the target changes.
   - Find the upstream of the target (`git rev-parse --abbrev-ref <target>@{upstream}`, e.g. `origin/WIP`). When it exists, run `git fetch <remote>`, and when the upstream is ahead of the target, fast-forward the target to it from the target checkout (`git merge --ff-only <upstream>`). If the target and its upstream diverged, set `move` to `stay`, write both SHAs under `## Merge`, and stop. When the target has no upstream, skip this bullet.
   - In the card worktree: `git merge --no-edit <target>`. On a conflict, follow Conflicts there. Do not abort before that attempt.
   - When the target already contains the same behavior as the card (the card reimplements work merged since it started), keep the target's version and drop the duplicate from the card side. Keep the card's tests when they still pass.
   - Run the project's test suite in the card worktree only when the code changed since it last passed. Read the latest `Suite` line (under `## Review`, else `## Result`): when `git rev-parse HEAD^{tree}` after the merge equals its tree and it says exit 0 (or only the baseline's failing tests), skip the suite and write `Suite: reused, tree <sha>` under `## Merge`. When the merge brought commits from the target (the tree changed), run only the affected tests in the card worktree (the affected-tests command written under `## Result`, see `nightshift-implement`'s Tests: it picks the tests the combined changes touch) and write their result under `## Merge`. When there is no `Suite` line at all (a card reviewed before it existed), run the full suite once. A failure beyond the baseline of `## Result`: fix the merge once and run the same tests again. A second failure follows Conflicts step 4.
   - Find where the target is checked out (`git worktree list --porcelain`), usually the board project. When it is not checked out anywhere, add a temporary worktree (`mktemp -d`, then `git worktree add <dir> <target>`). If the target checkout is dirty, set `move` to `stay` and stop. Ignored files, `nightshift.json` among them, do not count. Do not stash and do not reset.
   - From the target checkout: `git merge --ff-only nightshift/<card-id>`. If it refuses because the target moved meanwhile, go back to the first bullet of this step once. A second refusal: set `move` to `stay` and stop.
   - Do not use `--no-verify`. Do not amend.
8. Push the target, still holding the lock: `git push <remote> <target>` with the remote of the upstream found in step 7. Never use `--force`, `--force-with-lease`, or `--no-verify`. When the target has no upstream, write `Pushed: skipped, no upstream` under `## Merge` and continue.
   - Rejected because the remote moved: `git fetch <remote>`, go back to step 7 once (the card branch takes the new commits; the suite runs again because the tree changed), then push again.
   - A second rejection, or an authentication or network error: keep the local merge, do not reset the target, write the command and the error under `## Merge` with the `Into:` line, set `move` to `stay`, leave `questions` empty, remove the lock, and stop. The next run sees the branch already in the target and only retries the push.
9. Refresh the board's test selection cache first: when the card worktree has one that `nightshift-implement` seeded (step 3, for example `.testmondata`), copy it to a temporary name next to the same path in the board project, then `mv` it over (a reader never sees half a file). Then remove the card worktree (`git worktree remove <path>`). Delete `nightshift/<card-id>` and any `nightshift/<card-id>/*` branch that is fully merged (`git branch -d` only). Remove the temporary target worktree if step 7 created one.
10. Append `## Merge`. Set `move` to `next` and `questions` to an empty array. Remove the lock.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Updating the card

Return only what changes, in the structured output's `sections` list: `{"heading": "Result", "content": "…"}` replaces (or adds) the `## Result` section, `"op": "append"` adds lines to a section, `"op": "delete"` removes one. Do not return `description`: Nightshift keeps every section you do not name, byte for byte, and re-emitting the whole note costs minutes of generation. Use `description` only to restructure the whole note.

## Conflicts

When `git merge` stops with conflicts, fix them before aborting.

1. Resolve each file. Keep both sides when they add different code. Keep the card branch when the target only moved the same lines. Never drop a test. Never take `nightshift.json` from the card branch. If the note already answers a file under `## Questions`, apply that answer and do not ask again.
2. Stage the resolved files. Run the project's test suite in that checkout. If it fails, fix the resolution once and run the suite again.
3. When the suite passes, or the repo has no test command, finish with `git commit`. Do not use `--no-verify` and do not amend. Then continue step 7 at the fast-forward of the target, and step 8.
4. A conflict needs a human when the two sides contradict, a resolution would drop a test, or the suite still fails. Run `git merge --abort` in the card worktree so the branch is not left conflicted. Ask every unresolved file in one list. Set `move` to `stay`. See Questions.

## Questions

Use this in step 4, and in Conflicts when a human must decide. Ask in two places, same questions, same order. Under each question in the note, leave exactly three blank lines.

```markdown
## Questions

1. The card started from a detached HEAD. Which branch should receive the worktree? Recommended: WIP — the branch checked out in the board project now.



2. The file app.ts conflicts: keep the card branch, keep the target, or keep both? Recommended: keep both — the two sides add different code.



```

On the next run, the answer is the text under that question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use it. When both are empty, set `move` to `stay` and stop. Do not invent a branch name, and do not guess a conflict you could not fix.

## Merge

Append this to the note. Do not delete `## Result`.

```markdown
## Merge

- Into: <target>
- Test environment: stopped <pids>, or none running
- Merge commit: <sha>
- Pushed: <remote>/<target> at <sha>, or skipped, no upstream
- Worktree removed: <path>
- Card branch deleted: nightshift/<card-id>
```

## Output

Human intervention (`move` is `stay`, one question per unresolved file):

```json
{
  "title": "current title",
  "sections": [{"heading": "Merge", "content": "…"}, {"heading": "Questions", "content": "…three blank lines under each question…"}],
  "move": "stay",
  "summary": "Conflict in 2 files. Merge aborted. Human decision needed.",
  "questions": [
    "app.ts conflicts: keep the card branch, keep the target, or keep both? Recommended: keep both — the two sides add different code."
  ]
}
```

Done:

```json
{
  "title": "current title",
  "sections": [{"heading": "Merge", "content": "…"}, {"heading": "Questions", "op": "delete"}],
  "move": "next",
  "summary": "Merged nightshift/<card-id> into WIP, pushed origin/WIP and removed the worktree.",
  "questions": []
}
```

## Done when

- [ ] `nightshift/<card-id>` is an ancestor of the target, or the merge commit is on the target, or `## Result` says `Worktree: none` and the card's commits are on the base
- [ ] `## Merge` names the target on its `Into:` line
- [ ] No process of the card's test environment is still running
- [ ] The card worktree is gone, or there never was one (`Worktree: none`)
- [ ] A conflict was committed after a resolution, or aborted with one question per unresolved file
- [ ] The target was not left in a conflict or a dirty merge
- [ ] `nightshift.json` was not part of the merge
- [ ] The target was pushed to its upstream without force, or the note says it has no upstream
- [ ] The lock directory is gone
- [ ] `move` is `next` only when the merge and the push succeeded
