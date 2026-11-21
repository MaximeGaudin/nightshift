# Cards with `Worktree: none`

Read this only when `## Result` has `Worktree: none` (the project's worktree policy was `forbidden`, or `auto` chose the shared checkout). Its commits are already on the base branch, so there is nothing to merge: this skill only pushes the base. Decide from `## Result`, not from the current policy, since the policy may have changed after the card was implemented.

No branch, no worktree. Take the lock (step 2), stop the test environment (step 3), then, instead of the branch steps 4 to 9:

1. The base is the `Base` line under `## Result` (a retried run keeps the `Into:` of an earlier `## Merge`). Without a usable branch name, ask once.
2. Each sha of the `Commits` line under `## Result` must satisfy `git merge-base --is-ancestor <sha> <base>`. A missing one: set `move` to `stay`, write which under `## Merge`, and stop. Do not cherry-pick.
3. Push the base as in step 8, never `--force`. On a rejection: fetch, fast-forward the base to the remote when the checkout is clean, and push once more; then step 8's second-rejection rule.
4. Append `## Merge` with `Into: <base>`, `Merge commit: none (committed on <base>)`, the `Test environment` and `Pushed` lines, `Worktree removed: none` and `Card branch deleted: none`. Set `move` to `next` and remove the lock.
