# Nightshift

A kanban board that orchestrates Claude Code agents. One folder = one board; the whole board state lives in a single committable file, `nightshift.json`, at the folder root.

## Run

```sh
bun install
bun start [project-dir] [--port 4545] [--no-open]   # defaults to the current directory
bun run dev                                          # same, with hot reload
bun test
```

## Concepts

- **Inert column**: cards just sit there.
- **Done column**: every board has a system Done column (id `col_done`), always last. It is inert, cannot be removed or reordered, and is recreated if missing; agents moving a card into it raise no attention notification.
- **Skill column**: every card that enters it is processed by `claude -p` running the chosen skill, in the project folder. Each skill column has its own parallel agent limit (default 1, set in the columns editor); a global cap (default 3, shared by all open projects) bounds the total number of running agents.
- When done, the agent returns structured output (`--json-schema`): updated title/description, `move` (`next`, `stay` or a column id) and a summary. Nightshift applies it to the card and, if moved into another skill column, the next skill starts automatically.
- **Questions**: when an agent is blocked on human decisions, it returns all its `questions` at once and the card waits in its column ("Question pour vous"). Answering in the card resumes the same Claude session (`claude --resume`) with every Q/A pair. `AskUserQuestion` is disabled for agents.
- A card is (re)run when it enters a skill column; "Relancer" forces a new run. Moving or deleting a card during a run stops its agent.
- Skills are read from `<project>/.claude/skills` (project, committable) and `~/.claude/skills` (user). Project skills shadow user skills. New skills are created in the project.

## Files

- `<project>/nightshift.json`: columns and cards (commit it). External edits (e.g. `git pull`) are picked up live.
- `~/.nightshift/settings.json`: global settings (global cap on parallel agents, permission mode, model, extra `claude` args, recent projects).
- `~/.nightshift/logs/`: last agent log per card.

## Permissions

Agents run unattended with the configured `--permission-mode` (default `auto`: Claude Code's classifier approves or denies each action; anything it would escalate to a human is denied, since nobody is watching). Use "Arguments supplémentaires" for `--allowedTools`, `--max-budget-usd`, etc. `bypassPermissions` lets agents run any command in the project folder.

## Layout

- `bin/nightshift.ts`: CLI entry point.
- `src/server/`: `store.ts` (board file), `orchestrator.ts` (queue, `claude` processes, questions), `skills.ts`, `settings.ts`, `server.ts` (HTTP + WebSocket API, serves the UI).
- `src/web/`: React UI bundled by Bun.
- `test/`: tests, with `fake-claude.ts` standing in for the CLI.
