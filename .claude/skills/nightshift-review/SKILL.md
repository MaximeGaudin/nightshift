---
name: nightshift-review
description: Reviews a Nightshift implementation worktree, fixes every defect, and re-runs the tests in that worktree. Use when a Nightshift skill column reviews a card after implementation and before merge.
---

# Nightshift Review

Review the code, fix every finding, and test the produced worktree to ensure everything works as intended.

The worktree is the one implementation left: the `Worktree` line under `## Result`, branch `nightshift/<card-id>`. Review and fix only there. Do not merge into `main`. Do not push. Do not edit the shared checkout.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`, `id`). The description is the specification plus `## Result`.
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`, `test`). Do not edit `nightshift.json`.
- Do not call `AskUserQuestion`.
- The process starts in the board project, a git repository. Check with `git rev-parse --is-inside-work-tree`. If that fails, set `move` to `stay`, leave `questions` empty, write the error under `## Review`, and stop.

## Steps

Progress marker: at the start of each step, write `[nightshift-progress] N/M label` alone on its own line, where N is the current step number, M is the total number of steps, and label is a few words naming the step. Use the numbering of this `## Steps` list. A machine reads this line, so it overrides any concise or no-narration style.

1. Read the card. Branch is `nightshift/<card-id>`. Worktree path is the `Worktree` line under `## Result`. If that line is missing, find the path with `git worktree list`.
   - If the prompt has no card: set `move` to `stay`, ask one question for the card id, and stop.
   - If the branch does not exist: set `move` to `stay`, leave `questions` empty, write that under `## Review`, and stop.
   - If the worktree directory is gone, recreate it with `git worktree add <dir> nightshift/<card-id>` (`mktemp -d` for `<dir>`). On failure: write the error under `## Review`, set `move` to `stay`, and stop.
2. From here, every command runs in that worktree. Read `## Brief`, `## Architecture`, `## Tasks`, `## Tests`, and `## Definition of done`. Read the diff of this branch against `git merge-base HEAD main`. When `main` does not exist, read `git log` and the files this branch added.
3. List every finding. A finding is a defect: behavior that contradicts the spec, a failing check, a stub (`TODO`, `FIXME`, skipped test, empty body that only throws), or a security hole. A rename or a formatting note is not a finding. Do not change those.
4. Fix every finding in the worktree. One commit per fix, message `fix: <what>`, only the files that fix needs. Do not use `--no-verify` and do not amend. Do not stage `.env`, credential files, `nightshift.json`, or `nightshift-screenshots`. If a fix needs a product decision the spec does not answer, do not guess. Ask every such decision at once. See Questions. Set `move` to `stay` and stop.
5. Run the project's full test suite in the worktree, then every item in `## Definition of done` and every test in `## Tests`. A failure is a finding: fix it and run the suite again. A second failure of the same check: set `move` to `stay`, leave `questions` empty, write the command and the output under `## Review`, and stop. Do not commit a red tree.
6. When `test.url` is set, refresh screenshots so the human can check the fixed result. Start the existing `test.command`, wait until the url answers (`curl -sf -o /dev/null`, 10 tries, one second apart), then capture each screen already listed under `## Screenshots`:

```bash
npx --yes playwright screenshot --browser chromium --full-page --viewport-size=1280,800 "<url>" "<png>"
```

   Retry a file once on failure. Stop the server after. Leave the port free. Do not stage the PNGs. Keep the same absolute paths in `## Screenshots`. When there is no `test.url`, leave screenshots unchanged.
7. Keep `test` from the card when the command still runs this worktree. When the worktree path changed in step 1, rewrite `test.command` so it `cd`s to the new path. Omit `test` when the card had none.
8. Append `## Review`. Set `move` to `next` and `questions` to an empty array. Keep the worktree.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Questions

Use this only in step 4, when a fix needs a product decision. Ask in two places, same questions, same order. Under each question in the note, leave exactly three blank lines.

```markdown
## Questions

1. The spec does not say what happens when save fails: keep the draft, or discard it? Recommended: keep the draft — discarding loses the user's text.



```

On the next run, the answer is the text under that question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use it. When both are empty, set `move` to `stay` and stop. Do not invent the product rule. Fix the other findings before stopping.

## Review

Append this to the note. Do not delete `## Brief`, `## Progress`, `## Result`, `## Tests`, `## Definition of done`, or `## Screenshots`.

```markdown
## Review

- Worktree: <path>
- Findings fixed: <one line each, or "none">
- Suite: <command> → exit <code>
- Definition of done: passed
```

## Output

Blocked:

```json
{
  "title": "current title",
  "description": "the note plus ## Review, or ## Questions when a product decision is open",
  "move": "stay",
  "summary": "Stopped: suite still fails after one fix.",
  "questions": []
}
```

Done:

```json
{
  "title": "current title",
  "description": "the note plus ## Review",
  "move": "next",
  "summary": "Reviewed the worktree. Fixed 2 findings. Suite passed.",
  "questions": [],
  "test": { "command": "cd <worktree> && bun run dev --port 4546", "url": "http://localhost:4546" }
}
```

Omit `test` when the card has no test command.

## Done when

- [ ] Every finding is fixed and committed on `nightshift/<card-id>`, or there were none
- [ ] The suite and `## Definition of done` passed in that worktree
- [ ] The shared checkout was not edited
- [ ] `move` is `next` only when those checks passed
