# Worktree policies `auto` and `forbidden`

Read this only when the `Worktree policy:` line says `auto` or `forbidden`.

- `auto`: create the worktree (step 3), except when the change is trivial (documentation only, or a one-line fix) and no other agent runs on this project: the `<environment>` block shows no other card marked `[running]`, and `git worktree list` shows no `nightshift/*` worktree. Then use the shared checkout as in `forbidden`. When in doubt, create the worktree.
- `forbidden`: no worktree and no `nightshift/<card-id>` branch. The work directory is the board project, on the branch checked out there: record the base (branch and SHA) and commit on that branch directly. Do not switch branches. Leave other pending files alone. With no worktree, step 4 commits only the files this card is about to touch, and step 9 only requires that no file this card changed is left uncommitted.
- Without a worktree, `## Result` gets `Worktree: none`, `Branch:` is the base branch the commits are on, `Shared checkout:` says `committed to directly`, and `nightshift-merge` then only pushes the base.
