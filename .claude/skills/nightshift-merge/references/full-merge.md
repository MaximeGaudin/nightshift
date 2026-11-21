# Full merge procedure

Read when the prompt has no `<fast-merge>` block (the fast path is off, or the card resumes after an answer). The agent does everything below itself.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`).
- The process starts in the board project, a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the error under `## Merge`, and stop.

## Steps

1. Read the card. Branch is `nightshift/<card-id>`. Worktree path is the `Worktree` line under `## Result`. If that line is missing, find the path with `git worktree list`.
   - If the prompt has no card: set `move` to `stay`, ask one question for the card id, and stop.
   - When `## Result` has `Worktree: none`: read references/no-worktree.md and follow it instead of the next bullet and steps 4 to 9.
   - If the branch does not exist: when the note has a `## Merge` section naming `Into: <target>` and a merge commit, this run only retries the push (step 8) to that target. Otherwise set `move` to `stay`, leave `questions` empty, write that under `## Merge`, and stop.
2. Take the lock, the directory `.git/nightshift-merge.lock` with an `owner` file inside. Run these from the board project, where the process starts.
   - Run `mkdir .git/nightshift-merge.lock`. On success, write `<card-id> <UTC ISO time>` to `.git/nightshift-merge.lock/owner` and continue.
   - When it already exists, read `owner`. Treat the lock as stale when `owner` is missing, when it names this card (a previous run of this card stopped without releasing it), or when its time is more than 30 minutes old. Remove a stale lock with `rm -rf .git/nightshift-merge.lock` and take it again. Write "removed stale lock: <owner>" under `## Merge`.
   - When it is held by another card for 30 minutes or less, retry 5 times, waiting 2 seconds between tries. If it is still held, set `move` to `stay`, leave `questions` empty, write "the target is busy: lock held by <owner>" under `## Merge`, and stop.
   - Another merge may be running: never touch the target without holding the lock. Remove it (`rm -rf .git/nightshift-merge.lock`) before every later stop, including success.
3. Stop the card's test environment (the "Tester" button may have left it running, holding ports), here and before every later stop.
   - `curl -sS -X POST http://localhost:4545/api/cards/<card-id>/test/stop -H 'Content-Type: application/json' -d '{"project": "<board project>"}'` (default port; ignore an error).
   - Then what is left: pid files the start scripts wrote inside the worktree, and every process whose command line contains `/<basename of the worktree>/` (`ps -axo pid=,command= | grep -F`; the name, not the full path, since macOS may add `/private`), except this run's own shell and `grep`. `kill` (TERM), wait up to 5 seconds, `kill -9` the survivors, remove the pid files.
   - Never kill a process that does not belong to this worktree: the human's servers, the board project's, another card's test.
   - Write `Test environment: stopped <pids>` or `Test environment: none running` under `## Merge`. A process that survives `kill -9`: write its pid and command, set `move` to `stay`, remove the lock, and stop.
4. Find the target, the first of these that names a branch. Call it `<target>` from here on.
   - a `## Questions` answer that names a branch;
   - the `Into:` line of an earlier `## Merge` in this note (a retried run keeps its first target);
   - the branch on the `Base` line under `## Result`;
   - for a card implemented before the `Base` line existed: the branch checked out in the board project (`git symbolic-ref --short HEAD`).
   - If none names a branch (`Base` says `detached` and the board project is on a detached `HEAD`), or the named branch no longer exists, ask once. See Asking questions. Do not guess a branch.
   - Refuse a target named `nightshift/*`: set `move` to `stay`, write that under `## Merge`, and stop.
   - If the card branch is already contained in the target (`git merge-base --is-ancestor nightshift/<card-id> <target>`): push the target (step 8), remove the worktree if it is still listed, delete the branch with `git branch -d`, append `## Merge`, set `move` to `next`, remove the lock, and stop. A failed push follows step 8.
5. Refuse the merge when `git diff --name-only <target>...nightshift/<card-id> -- nightshift.json` prints a path. Set `move` to `stay`, leave `questions` empty, write that path under `## Merge`, and stop.
6. In the card worktree, run `git status --porcelain`. If it prints anything other than ignored secrets, set `move` to `stay` and stop. Do not commit those files here.
7. Bring the card branch up to date with the target in the card worktree, then move the target forward. The target is never left conflicted, and the suite runs on the combined code before the target changes.
   - Find the upstream of the target (`git rev-parse --abbrev-ref <target>@{upstream}`, e.g. `origin/WIP`). When it exists, run `git fetch <remote>`, and when the upstream is ahead of the target, fast-forward the target to it from the target checkout (`git merge --ff-only <upstream>`). If the target and its upstream diverged, set `move` to `stay`, write both SHAs under `## Merge`, and stop. When the target has no upstream, skip this bullet.
   - In the card worktree: `git merge --no-edit <target>`. On a conflict, follow Conflicts there. Do not abort before that attempt.
   - When the target already contains the same behavior as the card (the card reimplements work merged since it started), keep the target's version and drop the duplicate from the card side. Keep the card's tests when they still pass.
   - Tests, in the card worktree: read the latest `Suite` line (under `## Review`, else `## Result`). When `git rev-parse HEAD^{tree}` after the merge equals its tree and it passed (exit 0, or only the baseline's failures), write `Suite: reused, tree <sha>` under `## Merge`. When the tree changed, run the affected-tests command written under `## Result` and write its result under `## Merge`. With no `Suite` line at all, run the full suite once. A failure beyond the baseline: fix the merge once and run the same tests again; a second failure follows Conflicts step 4.
   - Find where the target is checked out (`git worktree list --porcelain`), usually the board project. When it is not checked out anywhere, add a temporary worktree (`mktemp -d`, then `git worktree add <dir> <target>`). If the target checkout is dirty, set `move` to `stay` and stop. Ignored files, `nightshift.json` among them, do not count. Do not stash and do not reset.
   - From the target checkout: `git merge --ff-only nightshift/<card-id>`. If it refuses because the target moved meanwhile, go back to the first bullet of this step once. A second refusal: set `move` to `stay` and stop.
   - Do not use `--no-verify`. Do not amend.
8. Push the target, still holding the lock: `git push <remote> <target>` with the remote of the upstream found in step 7. Never use `--force`, `--force-with-lease`, or `--no-verify`. When the target has no upstream, write `Pushed: skipped, no upstream` under `## Merge` and continue.
   - Rejected because the remote moved: `git fetch <remote>`, go back to step 7 once (the card branch takes the new commits; the suite runs again because the tree changed), then push again.
   - A second rejection, or an authentication or network error: keep the local merge, do not reset the target, write the command and the error under `## Merge` with the `Into:` line, set `move` to `stay`, leave `questions` empty, remove the lock, and stop. The next run sees the branch already in the target and only retries the push.
9. When the card worktree has a test selection cache `nightshift-implement` seeded (for example `.testmondata`), copy it to a temporary name next to the same path in the board project, then `mv` it over. Then remove the card worktree (`git worktree remove <path>`). Delete `nightshift/<card-id>` and any `nightshift/<card-id>/*` branch that is fully merged (`git branch -d` only). Remove the temporary target worktree if step 7 created one.
10. Append `## Merge`. Set `move` to `next` and `questions` to an empty array. Remove the lock.

The Conflicts rules are in SKILL.md; the output and the `## Merge` format too.
