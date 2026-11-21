# Cards with `Worktree: none`

Read this only when `## Result` has `Worktree: none` (the project's worktree policy let `nightshift-implement` commit on the base branch in the shared checkout).

There is no card branch and no worktree. The work directory is the board project, on the branch of the `Base` line. Skip the branch and worktree-recreation bullets of step 1. The card's changes are the commits of the `Commits` line, so the diff of step 2 is `<sha of the Base line>..HEAD`. Fixes are committed on that branch, the one case where this skill edits the shared checkout. Everywhere, "the worktree" means that checkout.
