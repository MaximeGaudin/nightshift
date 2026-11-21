# Pull request mode

Read this only when the prompt's `<environment>` has a line `Pull requests: github via gh (merge method: <m>, auto-merge: on|off)`. Use the merge method of that line everywhere below.

In this mode Nightshift pushed `nightshift/<card-id>` and opened its pull request after the review (`- PR: <url>` under `## Review`), and its fast path merges the PR with `gh pr merge`. A card with `Worktree: none`, or whose base is not on `origin`, still follows the local flow of SKILL.md.

You run when that fast path stopped. The `<fast-merge>` block names one of these steps:

- `pr-conflict`: the PR conflicts with its base.
  1. Take the lock and stop the test environment (SKILL.md steps 2 and 3).
  2. In the card worktree: `git fetch origin`, then `git merge origin/<base>`. Fix the conflicts as in SKILL.md's Conflicts section, commit, and run the affected tests (SKILL.md step 7).
  3. `git push origin nightshift/<card-id>`. Never `--force`, never `--no-verify`.
  4. `gh pr merge <url> --<merge method> --delete-branch`, run from a directory outside the repository (for example `/tmp`), so gh does not touch the local branches.
  5. Then the cleanup below. Remove the lock.
- `pr-closed`: the PR was closed without being merged. Do not reopen it on your own. Set `move` to `stay` and ask one question: reopen the PR (`gh pr reopen <url>`), merge locally as without pull requests, or abandon the card. Recommended: reopen.
- `pr-protected`: a branch protection refused the merge (approval or status required). Nightshift never approves a PR. Set `move` to `stay` and ask the human to approve or fix it on GitHub, quoting the `Error` line, then to retry the Merge column.
- `pr-other`, `pr-auth`, `pr-network`, `pr-missing`: retry the failed command once. A second failure: write the command and the error under `## Merge`, set `move` to `stay`, and stop.

When required checks are still pending, Nightshift does not start you: the card waits in Merge, and its CI watcher follows the PR.

## Cleanup after the merge

1. `gh pr view <url> --json state,mergeCommit`: the state must be `MERGED`.
2. `git fetch origin`. When the checkout of the base is clean (`git status --porcelain --untracked-files=no` prints nothing), `git merge --ff-only origin/<base>` there. Otherwise write why under `## Merge` and leave the base alone.
3. `git worktree remove <worktree>`, then `git branch -D nightshift/<card-id>` (`-D`: a squash or a rebase leaves the branch out of the base).
4. Write `## Merge` with `- PR: <url> merged (<short merge sha>)`, `- Into: <base>` and the `Test environment`, `Worktree removed` and `Card branch deleted` lines. Set `move` to `next`.
