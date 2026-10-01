# Nightshift

A kanban board that orchestrates Claude Code agents. One folder = one board; the whole board state lives in a single file, `nightshift.json`, at the folder root (commit it in your projects; this repository ignores its own, see Files).

## Run

```sh
bun install
bun start [project-dir] [--port 4545] [--no-open] [--no-agents]   # defaults to the current directory
bun run dev                                                        # same as start (development mode: HMR and browser console echo unless NODE_ENV=production)
bun test
```

Options: `--port <n>` / `-p <n>` (0..65535, also read from the `PORT` environment variable, default 4545), `--no-open` (do not open the browser), `--no-agents` (never start agents), `--help`. Environment: `NIGHTSHIFT_HOME` (data directory, default `~/.nightshift`), `NIGHTSHIFT_USER_SKILLS` (user skills directory, default `~/.claude/skills`), `NIGHTSHIFT_NO_OPEN` (set to any value to skip opening the browser).

The server listens on `127.0.0.1` only, and rejects requests whose `Host` or `Origin` is not local or whose body is not `application/json`.

Development scripts: `bun run lint` (Biome), `bun run format`, `bun run typecheck`, `bun test`, `bun run test:coverage`, and `bun run check` (lint + typecheck + tests, run it before committing). Code is formatted and linted with [Biome](https://biomejs.dev).

## Concepts

- **Inert column**: cards just sit there.
- **Done column**: every board has a system Done column (id `col_done`), always last. It is inert, cannot be removed or reordered, and is recreated if missing; agents moving a card into it raise no attention notification.
- **Skill column**: every card that enters it is processed by `claude -p` running the chosen skill, in the project folder. Each skill column has its own parallel agent limit (default 1, set in the columns editor); a global cap (default 3, shared by all open projects) bounds the total number of running agents.
- When done, the agent returns structured output (`--json-schema`): updated title/description, `move` (`next`, `stay` or a column id) and a summary. Nightshift applies it to the card and, if moved into another skill column, the next skill starts automatically.
- **Questions**: when an agent is blocked on human decisions, it returns all its `questions` at once and the card waits in its column ("Question pour vous"). Answering in the card resumes the same Claude session (`claude --resume`) with every Q/A pair. `AskUserQuestion` is disabled for agents.
- **Feedback**: from a card's detail, in any column (inert too), you can send free-text feedback to the agent. It resumes the card's last Claude session (`claude --resume`) with your text and the current card; the agent returns `move` (`stay`, `next` = the column after the card's current column, or a column id) and may ask questions as usual. A failed or cancelled run leaves the card in place and the feedback can be sent again.
- A card is (re)run when it enters a skill column; "Relancer" forces a new run. Moving or deleting a card during a run stops its agent.
- **Progression**: a running card shows live progress (step N/M and a label). Agents emit a line `[nightshift-progress] N/M label` at each step (a numbered `## Progress` section in the card sets numbering and total); until a marker is seen, the agent's TodoWrite list is used instead. Last value wins, it resets at each (re)start of the agent and is never saved in `nightshift.json`.
- Skills are read from `<project>/.claude/skills` (project, committable) and `~/.claude/skills` (user). Project skills shadow user skills. New skills are created in the project.

## Mode séquentiel

Un bouton lecture/pause du tableau fait avancer les cartes une par une : « lecture » déplace la première carte de la première colonne (le backlog) dans la deuxième, saute les colonnes inertes (hors Done), puis lance la suivante quand la carte arrive dans Done. « Pause » laisse la carte en cours finir mais ne lance pas la suivante. La séquence s'arrête (avec un message) si le backlog est vide, si la carte est supprimée ou ramenée dans le backlog, ou si son run échoue, est annulé ou laisse la carte sur place ; une question en attente ne l'arrête pas. Un nouvel appui sur lecture reprend la carte arrêtée. L'état est en mémoire (jamais dans `nightshift.json`) ; routes `POST /api/sequence/play` et `/api/sequence/pause` (`{project}`), refusées (409) sur une instance sans agents.

## Files

- `<project>/nightshift.json`: columns and cards. Commit it in your projects. This repository ignores it (`.gitignore`): it is the dogfooding board of Nightshift itself. External edits (e.g. `git pull`) are picked up live.
- `~/.nightshift/settings.json`: global settings (global cap on parallel agents, permission mode, model, extra `claude` args, recent projects).
- `~/.nightshift/logs/`: last agent log per card (removed with the card).
- `~/.nightshift/screenshots/`: card screenshots.
- `~/.nightshift/locks/`: one lock per open project folder.

## Permissions

Agents run unattended with the configured `--permission-mode` (default `auto`: Claude Code's classifier approves or denies each action; anything it would escalate to a human is denied, since nobody is watching). Use "Arguments supplémentaires" for `--allowedTools`, `--max-budget-usd`, etc. `bypassPermissions` lets agents run any command in the project folder.

## Layout

- `bin/nightshift.ts`: CLI entry point.
- `src/server/`: `store.ts` (board file), `orchestrator.ts` (queue, `claude` processes, questions), `skills.ts`, `settings.ts`, `server.ts` (HTTP + WebSocket API, serves the UI).
- `src/web/`: React UI bundled by Bun.
- `test/`: tests, with `fake-claude.ts` standing in for the CLI.
