# Cards that change a screen

Read this only when the card changes a screen. Capture (`## Screenshots`) only when `Card path` has no `nightshift-review` column left; otherwise review captures: `git diff --name-only <base sha>` lists UI code, or the brief names a page.

## Start the app

A screen usually needs more than its front end: a backend, a database, other services. Start everything it needs from the worktree, backends first, the front end last.

- Use the start command the column instructions give. Otherwise the project's own: a `dev` or `start` script, a compose file, or the run command of the README.
- The worktree has none of the files git ignores: `.env`, local secrets, virtualenvs, `node_modules`. Link env, secret and virtualenv files from the board project (`ln -s`, only when missing). Never copy, print or stage them. Install missing dependencies with the project's installer.
- Pick free ports: the first port from the default + 1 for which `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing, never the project's default, passed with the port flag or `PORT=<port>`. Point the front end at the backend's port.
- Start backends in the background and wait until each answers its health or base URL (10 tries, one second apart). Keep the front end in the foreground, so stopping the command stops the whole stack.
- When the app asks for a key or a login, the human has it. Do not write it in the note.
- To stop: end the command, then any background process it started from the worktree. Leave the ports free.

## Test command

`test.command` starts the whole stack above from this run's worktree (`cd <work directory> &&`, install when missing, then the start command). Keep browser auto-opening: never pass `--no-open` or similar. Set `test.url` to the page (`http://localhost:<port>`).

## Screenshots

1. Start `test.command` in the background with the start command's no-browser flag or variable for this run only (`NIGHTSHIFT_NO_OPEN=1` for Nightshift itself); the stored `test.command` does not change. Retry `curl -sf -o /dev/null <url>` 10 times, one second apart. If it never answers, stop the process, write the error under `## Screenshots`, and continue: a missed screenshot never fails the card.
2. Save one PNG per screen the brief names (else `test.url` once as `01-home.png`) in `<worktree>/nightshift-screenshots/`, numbered `01-slug.png`, `02-slug.png`, from the worktree with the project's Playwright (`<worktree>/node_modules/.bin/playwright`, else the board project's; `bunx playwright` when `bun.lock` exists and `package.json` declares `playwright` or `@playwright/test`; else `npx --yes playwright`, which resolves the package on every call; on a missing browser, retry once with `npx --yes playwright`): `playwright screenshot --browser chromium --full-page --viewport-size=1280,800 "<url>" "<png>"`. Retry a failed file once, then write its error under `## Screenshots` and go on.
3. Stop the server you started, so the port is free for the Tester button. Do not stage or commit `nightshift-screenshots`.
4. Append `## Screenshots`: one markdown image per PNG, absolute path, alt text the screen name (`![Home](/abs/path/nightshift-screenshots/01-home.png)`).
