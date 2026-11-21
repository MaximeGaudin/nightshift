---
name: nightshift-review
description: Reviews a Nightshift implementation worktree, fixes every defect, and re-runs the tests in that worktree. Use when a Nightshift skill column reviews a card after implementation and before merge.
---

# Nightshift Review

Review the code, fix every finding, and test the produced worktree.

The worktree is the one implementation left: the `Worktree` line under `## Result`, branch `nightshift/<card-id>`. Review and fix only there. The base is the branch on the `Base` line under `## Result`, the branch the card started from (for example `WIP` or `main`). Do not merge, push, call `gh`, or edit the shared checkout. In pull request mode (`<environment>` has a `Pull requests:` line), Nightshift pushes and opens or updates the PR after a successful review.

## Prerequisites

- The worker prompt contains the card (`<title>`, `<description>`, `id`): the specification plus `## Result`.
- The process starts in the board project, a git repository (`git rev-parse --is-inside-work-tree`), else `stay` with the error under `## Review`.

## Steps

1. Read the card. Branch is `nightshift/<card-id>`. Worktree path is the `Worktree` line under `## Result`. If that line is missing, find the path with `git worktree list`.
   - No card: set `move` to `stay`, ask for the card id, and stop.
   - When `## Result` has `Worktree: none`: read references/no-worktree.md; it replaces the next two bullets and sets the diff of step 2.
   - If the branch does not exist: set `move` to `stay`, leave `questions` empty, write that under `## Review`, and stop.
   - If the worktree directory is gone, recreate it with `git worktree add <dir> nightshift/<card-id>` (`mktemp -d`). On failure: write the error under `## Review`, set `move` to `stay`, and stop.
2. From here, every command runs in that worktree. Read the grilled note (the top of the description), `## Architecture`, `## Tasks`, `## Tests`, and `## Definition of done`; a card that skipped `nightshift-plan` has `## Plan`, `## Acceptance` and the `## Definition of done` the implement agent wrote instead: review against those. Read the diff of this branch against `git merge-base HEAD <base>`. When `Base` says `detached`, use its SHA. When the line is missing, use the branch checked out in the board project. When none of these exists, read `git log` and the files this branch added.
3. List every finding. A finding is a defect: behavior that contradicts the spec, a failing check, a stub (`TODO`, `FIXME`, skipped test, empty body that only throws), or a security hole. A rename or a formatting note is not a finding. Do not change those.
   - When the note has `## CI` (failed required checks with log excerpts), each failed check is a finding. After the fix, replace the section with `- CI: corrigé dans <sha>`.
4. Fix every finding in the worktree. One commit per fix, message `fix: <what>`, only the files that fix needs. Do not use `--no-verify` and do not amend. Do not stage `.env`, credential files, `nightshift.json`, or `nightshift-screenshots`. If a fix needs a product decision the spec does not answer, do not guess. Ask every such decision at once (see Asking questions). Set `move` to `stay` and stop.
5. Run the full test suite here, once, after the last fix of step 4: the only place in the Nightshift flow where it runs. Use the suite command of `## Definition of done` when it names one, else the project's whole check (lint, types and all tests: `check` if it exists, else `test`, or what the README names) for every part the card changed. Then the items of `## Definition of done` and `## Tests` the suite does not cover, including those marked "deferred to review". While fixing in step 4, run only the affected-tests command written under `## Result`.
   - Tests already failing on the base (the `Baseline` line of `## Result`) are not findings of this card; any other failure is.
   - When a later run of this skill finds no fix to make and `git rev-parse HEAD^{tree}` equals the tree of the latest `Suite` line under `## Review`, do not re-run the suite: write `Suite: reused, tree <sha>`.
   - A failure is a finding: fix it and run the suite again. A second failure of the same check: set `move` to `stay`, write the command and the output under `## Review`, and stop. Do not commit a red tree.
   - Write the `Suite` line under `## Review` in the same format as `## Result` (`Suite: <command> → exit <code>, failing: <…>, tree <sha>`), so `nightshift-merge` can reuse it.
6. Check `test` on every run, even with nothing to fix: the "Tester" button runs `test.command` as written, and an output without `test` keeps the old one.
   - The card changes a screen (`git diff --name-only <base>` lists UI code, or the brief names a page): read references/ui-cards.md, check `test` and refresh the screenshots as it says.
   - Otherwise `test.command` is the affected-tests command in the worktree, with no `url`; start no server. It must `cd` into this run's worktree: rewrite the path when the worktree changed. Return it in the output. Omit `test` only when the card had none.
8. Append `## Review`, with the line `- Test: <test.command>` when the card has a `test`. Set `move` to `next` and `questions` to an empty array. Keep the worktree.

## Use the context you were given

- Read the diff against the base (step 2) and the code around each hunk; open other files only when a hunk calls into them and the card does not describe the contract.
- Trust the card's `Context` and `Architecture`: do not re-derive them, and do not re-run what `## Result` says ran unless the tree changed.
- No repository-wide `grep`/`rg` sweeps, directory listings or Explore agents. Search for one symbol when a hunk needs it.

## Asking questions

Use this only in step 4, when a fix needs a product decision, for example: "The spec does not say what happens when save fails: keep the draft, or discard it? Recommended: keep the draft — discarding loses the user's text." When an answer is empty in the note and in the resume prompt, set `move` to `stay` and stop: do not invent the product rule. Fix the other findings before stopping.

## Writing the review

Append this to the note. Do not delete `## Progress`, `## Result`, `## Tests`, `## Definition of done`, or `## Screenshots`.

```markdown
## Review

- Worktree: <path>
- Findings fixed: <one line each, or "none">
- Suite: <command> → exit <code>
- Definition of done: passed
```

## Output

Done (when blocked: `move` is `stay`, with `## Review` and the questions):

```json
{
  "title": "current title",
  "sections": [{"heading": "Review", "content": "…"}],
  "move": "next",
  "summary": "Reviewed the worktree. Fixed 2 findings. Suite passed.",
  "questions": [],
  "test": {
    "command": "cd <worktree> && (test -d node_modules || bun install) && (PORT=8091 bun run api &) && API_URL=http://127.0.0.1:8091 bun run dev --port 5174",
    "url": "http://localhost:5174/"
  }
}
```

Omit `test` only when the card has no test command. A `test` that only starts a front-end dev server without its backend is never returned.

## Done when

- [ ] Every finding is fixed and committed, and the shared checkout was not edited (except with `Worktree: none`)
- [ ] `## Review` has a `Suite` line that passed or was reused, with its tree
- [ ] `test` was returned and, for a screen, seen answering with everything it needs (references/ui-cards.md)
- [ ] `move` is `next` only when those checks passed
