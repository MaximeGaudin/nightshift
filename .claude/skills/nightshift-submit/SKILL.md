---
name: nightshift-submit
description: Submits a task to a project's Nightshift backlog with POST /api/backlog on the local Nightshift server (project path, title, description). Use when asked to add, file, queue or send a task, ticket or card to Nightshift or its backlog.
---

# Nightshift Submit

Create one card in the Backlog column of a Nightshift board.

## Prerequisites

- A Nightshift server runs on this machine, port 4545 by default (`PORT` or `--port` changes it).
- The project has a board: a `nightshift.json` at its root.

## Steps

1. Find the project path, the board's id. It is the absolute folder that holds `nightshift.json`, without `~`.
   - By default, walk up from the current directory to the first folder with `nightshift.json`.
   - Inside a git worktree, which has no `nightshift.json`, use the main checkout: the first `worktree` line of `git worktree list --porcelain`.
   - When the user names another project, use that folder.
2. Write the card: a short `title` in the imperative, and a markdown `description` with the context, the expected result, and the acceptance criteria. One task per card.
3. Send it:

   ```sh
   curl -sS -X POST http://localhost:4545/api/backlog \
     -H 'Content-Type: application/json' \
     -d '{"project": "/abs/path/to/project", "title": "Fix the login bug", "description": "…", "source": "claude"}'
   ```

   Build the JSON body with a tool that escapes strings (for example `jq -n --arg`), never by hand.
4. Read the answer.
   - `201 {"id":"card_…","number":12,"ref":"#12"}`: report the ref (`#12`) to the user.
   - Connection refused: the server is not running. Tell the user to start it with `bun start <project>` and stop.
   - `404`: the folder has no board. Stop and report the path you used.
   - `400`: fix the field named in `error` once and retry. A second failure: stop and report it.

Optional fields: `skipColumnIds` (array of column ids that `next` skips for this card) and `source` (up to 100 characters, shown in the card history). The card always lands in Backlog; `columnId` is ignored.

## Done when

- [ ] The server answered 201 and the user has the card ref, or the user knows why no card was created
