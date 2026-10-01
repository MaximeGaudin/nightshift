---
name: nightshift-merge
description: Merges a Nightshift implementation worktree into main and tries to fix conflicts. Asks a human when a conflict cannot be fixed. Use when a Nightshift skill column merges a finished implementation card into main.
---

# Nightshift Merge

Merge the worktree into main.

The worktree and the branch come from `nightshift-implement`: branch `nightshift/<card-id>`, path on the `Worktree` line under `## Result`. This skill merges that branch into `main`, pushes `main` to its upstream, then removes the worktree. Push only `main`, never a card branch, and never force. Do not implement.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`).
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`). Do not edit `nightshift.json`.
- Do not call `AskUserQuestion`.
- The process starts in the board project, a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the error under `## Merge`, and stop.
- Another merge may be running. Take the lock in step 2 before touching `main`. Set the merge column's "Agents en parallèle dans cette colonne" to 1 in Nightshift so merges run one at a time; the lock stays as a guard.

## Steps

1. Read the card. Branch is `nightshift/<card-id>`. Worktree path is the `Worktree` line under `## Result`. If that line is missing, find the path with `git worktree list`.
   - If the prompt has no card: set `move` to `stay`, ask one question for the card id, and stop.
   - If the branch is already contained in `main` (`git merge-base --is-ancestor nightshift/<card-id> main`): take the lock (step 2), push `main` (step 7), remove the worktree if it is still listed, delete the branch with `git branch -d`, append `## Merge`, set `move` to `next`, remove the lock, and stop. A failed push follows step 7.
   - If the branch does not exist and is not in `main`: set `move` to `stay`, leave `questions` empty, write that under `## Merge`, and stop.
2. Take the lock, the directory `.git/nightshift-merge.lock` with an `owner` file inside. Run these from the board project, where the process starts.
   - Run `mkdir .git/nightshift-merge.lock`. On success, write `<card-id> <UTC ISO time>` to `.git/nightshift-merge.lock/owner` and continue.
   - When it already exists, read `owner`. Treat the lock as stale when `owner` is missing, when it names this card (a previous run of this card stopped without releasing it), or when its time is more than 30 minutes old. Remove a stale lock with `rm -rf .git/nightshift-merge.lock` and take it again. Write "removed stale lock: <owner>" under `## Merge`.
   - When it is held by another card for 30 minutes or less, retry 5 times, waiting 2 seconds between tries. If it is still held, set `move` to `stay`, leave `questions` empty, write "main is busy: lock held by <owner>" under `## Merge`, and stop.
   - Remove the lock (`rm -rf .git/nightshift-merge.lock`) before every later stop, including success. Never touch `main` without holding it.
3. Confirm `main` exists (`git rev-parse --verify main`). If it does not, ask once. See Questions. Do not merge into another branch unless the answer names it.
4. Refuse the merge when `git diff --name-only main...nightshift/<card-id> -- nightshift.json` prints a path. Set `move` to `stay`, leave `questions` empty, write that path under `## Merge`, and stop.
5. In the card worktree, run `git status --porcelain`. If it prints anything other than ignored secrets, set `move` to `stay` and stop. Do not commit those files here.
6. Bring the card branch up to date with `main` in the card worktree, then move `main` forward. `main` is never left conflicted, and the suite runs on the combined code before `main` changes.
   - Find the upstream of `main` (`git rev-parse --abbrev-ref main@{upstream}`, e.g. `origin/main`). When it exists, run `git fetch <remote>`, and when the upstream is ahead of `main`, fast-forward `main` to it from the `main` checkout (`git merge --ff-only <upstream>`). If `main` and its upstream diverged, set `move` to `stay`, write both SHAs under `## Merge`, and stop. When `main` has no upstream, skip this bullet.
   - In the card worktree: `git merge --no-edit main`. On a conflict, follow Conflicts there. Do not abort before that attempt.
   - When `main` already contains the same behavior as the card (the card reimplements work merged since it started), keep `main`'s version and drop the duplicate from the card side. Keep the card's tests when they still pass.
   - Run the project's test suite in the card worktree. If it fails, fix the merge once and run it again. A second failure follows Conflicts step 4.
   - Find where `main` is checked out (`git worktree list --porcelain`). If that checkout is dirty, set `move` to `stay` and stop. Do not stash and do not reset. If `main` is not checked out anywhere, add a temporary worktree (`mktemp -d`, then `git worktree add <dir> main`).
   - From the `main` checkout: `git merge --ff-only nightshift/<card-id>`. If it refuses because `main` moved meanwhile, go back to the first bullet of this step once. A second refusal: set `move` to `stay` and stop.
   - Do not use `--no-verify`. Do not amend.
7. Push `main`, still holding the lock: `git push <remote> main` with the remote of the upstream found in step 6. Never use `--force`, `--force-with-lease`, or `--no-verify`. When `main` has no upstream, write `Pushed: skipped, no upstream` under `## Merge` and continue.
   - Rejected because the remote moved: `git fetch <remote>`, go back to step 6 once (the card branch takes the new commits, the suite runs again), then push again.
   - A second rejection, or an authentication or network error: keep the local merge, do not reset `main`, write the command and the error under `## Merge`, set `move` to `stay`, leave `questions` empty, remove the lock, and stop. The next run sees the branch already in `main` and only retries the push.
8. Remove the card worktree (`git worktree remove <path>`). Delete `nightshift/<card-id>` and any `nightshift/<card-id>/*` branch that is fully merged (`git branch -d` only). Remove the temporary `main` worktree if step 6 created one.
9. Append `## Merge`. Set `move` to `next` and `questions` to an empty array. Remove the lock.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Conflicts

When `git merge` stops with conflicts, fix them before aborting.

1. Resolve each file. Keep both sides when they add different code. Keep the card branch when `main` only moved the same lines. Never drop a test. Never take `nightshift.json` from the card branch. If the note already answers a file under `## Questions`, apply that answer and do not ask again.
2. Stage the resolved files. Run the project's test suite in that checkout. If it fails, fix the resolution once and run the suite again.
3. When the suite passes, or the repo has no test command, finish with `git commit`. Do not use `--no-verify` and do not amend. Then continue step 6 at the fast-forward of `main`, and step 7.
4. A conflict needs a human when the two sides contradict, a resolution would drop a test, or the suite still fails. Run `git merge --abort` in the card worktree so the branch is not left conflicted. Ask every unresolved file in one list. Set `move` to `stay`. See Questions.

## Questions

Use this in step 3, and in Conflicts when a human must decide. Ask in two places, same questions, same order. Under each question in the note, leave exactly three blank lines.

```markdown
## Questions

1. This repository has no main branch. Which branch should receive the worktree? Recommended: master — use it only when master already exists.



2. The file app.ts conflicts: keep the card branch, keep main, or keep both? Recommended: keep both — the two sides add different code.



```

On the next run, the answer is the text under that question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use it. When both are empty, set `move` to `stay` and stop. Do not invent a branch name, and do not guess a conflict you could not fix.

## Merge

Append this to the note. Do not delete `## Result`.

```markdown
## Merge

- Into: main
- Merge commit: <sha>
- Pushed: <remote>/main at <sha>, or skipped, no upstream
- Worktree removed: <path>
- Card branch deleted: nightshift/<card-id>
```

## Output

Human intervention (`move` is `stay`, one question per unresolved file):

```json
{
  "title": "current title",
  "description": "the note plus ## Questions, three blank lines under each question",
  "move": "stay",
  "summary": "Conflict in 2 files. Merge aborted. Human decision needed.",
  "questions": [
    "app.ts conflicts: keep the card branch, keep main, or keep both? Recommended: keep both — the two sides add different code."
  ]
}
```

Done:

```json
{
  "title": "current title",
  "description": "the note plus ## Merge",
  "move": "next",
  "summary": "Merged nightshift/<card-id> into main, pushed origin/main and removed the worktree.",
  "questions": []
}
```

## Done when

- [ ] `nightshift/<card-id>` is an ancestor of `main`, or the merge commit is on `main`
- [ ] The card worktree is gone
- [ ] A conflict was committed after a resolution, or aborted with one question per unresolved file
- [ ] `main` was not left in a conflict or a dirty merge
- [ ] `nightshift.json` was not part of the merge
- [ ] `main` was pushed to its upstream without force, or the note says it has no upstream
- [ ] The lock directory is gone
- [ ] `move` is `next` only when the merge and the push succeeded
