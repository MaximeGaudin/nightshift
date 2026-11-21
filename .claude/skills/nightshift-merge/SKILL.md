---
name: nightshift-merge
description: Merges a Nightshift implementation worktree back into the branch the card started from (for example WIP or main) and tries to fix conflicts. Asks a human when a conflict cannot be fixed. Use when a Nightshift skill column merges a finished implementation card into the current branch.
---

# Nightshift Merge

Branch `nightshift/<card-id>`, worktree path on the `Worktree` line under `## Result`, target on the `Base` line under `## Result` (for example `WIP` or `main`). Merge the card branch into the target, push the target to its upstream, remove the worktree. Push only the target, never a card branch, never force. Do not implement.

- `Worktree: none` under `## Result`: read references/no-worktree.md instead.
- `Pull requests:` line in `<environment>`: read pull-requests.md first.
- No `<fast-merge>` block in the prompt (fast path off, or a resumed card): read references/full-merge.md and follow it. Everything else below assumes the block.

## Fast path stopped

Nightshift tries the whole merge itself (lock, test environment stop, merge, tests, fast-forward, push, cleanup) and starts you only when it stopped. The prompt ends with:

```
<fast-merge>
Step: <read-result, lock, stop-test, check-card, check-commits, upstream, base-checkout, moved-base, merge-base-into-card, test, ff-base, push>
Command: <the command it ran>
Error: <its error, or the last 50 lines of the test output>
State left: <what it left behind>
</fast-merge>
```

The lock is released and no merge is in progress. Read `Command`, `Error` and `State left`, then resume from there. Never touch the target without the lock: `mkdir .git/nightshift-merge.lock` (write `<card-id> <UTC time>` in `owner`; a lock older than 30 minutes or owned by this card is stale), and `rm -rf` it before every stop, success included.

- `merge-base-into-card` (conflict) or `test` (failure): in the card worktree, `git merge --no-edit <target>` if no merge is in progress, then follow Conflicts. A merge commit of the base left on the card branch means only the tests and the fast-forward remain.
- `State left` says a local merge is kept on the target and not pushed: the card is already in it, only the push remains.
- `check-card`, `base-checkout`, `moved-base`, `upstream`, `push`, `read-result`, `check-commits`, `stop-test`, `lock`: a dirty checkout, a moved or diverged target, a rejected push or a missing field. Fix what the error names if it is safe (a push rejected because the remote moved: `git fetch`, merge it into the card branch, re-run the tests, push again once). Otherwise set `move` to `stay`, leave `questions` empty, write the command and the error under `## Merge`, and stop. A missing or unknown target: ask once (see Asking questions); refuse `nightshift/*`.
- references/full-merge.md has the detail of any step you must do yourself.

Then finish: tests on the combined code, `git merge --ff-only nightshift/<card-id>` from the target checkout, `git push <remote> <target>` (never `--force` or `--no-verify`; a target without upstream: `Pushed: skipped, no upstream`), then the cleanup: stop the card's test environment (`POST http://localhost:4545/api/cards/<card-id>/test/stop` with `{"project": "<board project>"}`, then only processes whose command line holds the worktree's name), `git worktree remove <path>`, `git branch -d nightshift/<card-id>`. Refuse the merge when the card changes `nightshift.json`.

## Conflicts

When `git merge` stops with conflicts, fix them before aborting.

1. Resolve each file. Keep both sides when they add different code. Keep the card branch when the target only moved the same lines. Never drop a test. Never take `nightshift.json` from the card branch. Apply an answer already under `## Questions`, do not ask again.
2. Stage the files and run the affected-tests command written under `## Result` (the full suite when there is none). A failure: fix the resolution once and run again.
3. When the tests pass, `git commit` (no `--no-verify`, no amend), then fast-forward and push.
4. A conflict needs a human when the two sides contradict, a resolution would drop a test, or the tests still fail. Run `git merge --abort` in the card worktree. Ask every unresolved file in one list, set `move` to `stay`.

## Asking questions

One question per unresolved file, for example "The file app.ts conflicts: keep the card branch, keep the target, or keep both? Recommended: keep both — the two sides add different code." On an empty answer, set `move` to `stay` and stop: never invent a branch name or guess a conflict you could not fix.

## Writing the merge note

Append this. Do not delete `## Result`.

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

```json
{
  "title": "current title",
  "sections": [{"heading": "Merge", "content": "…"}, {"heading": "Questions", "op": "delete"}],
  "move": "next",
  "summary": "Merged nightshift/<card-id> into WIP, pushed origin/WIP and removed the worktree.",
  "questions": []
}
```

`move` is `next` only when the merge and the push succeeded.
