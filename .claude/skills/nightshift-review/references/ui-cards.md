# Cards that change a screen

Read this only when the card changes a screen: `git diff --name-only <base>` lists UI code, or the brief names a page.

## Run the app

A screen usually needs more than its front end: a backend, a database, other services. Start everything it needs from the worktree, backends first, the front end last.

- Use the start command the column instructions give. Otherwise the project's own: a `dev` or `start` script, a compose file, or the run command of the README.
- The worktree has none of the files git ignores: `.env`, local secrets, virtualenvs, `node_modules`. Link env, secret and virtualenv files from the board project (`ln -s`, only when missing). Never copy, print or stage them. Install missing dependencies with the project's installer.
- Pick free ports (`lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing), never the project's default ones: the human's own servers may hold them. Point the front end at the backend's port.
- Start backends in the background and wait until each answers its health or base URL (10 tries, one second apart). Keep the front end in the foreground, so stopping the command stops the whole stack.
- When the app asks for a key or a login, the human has it. Do not write it in the note.
- To stop: end the command, then any background process it started from the worktree. Leave the ports free.

## Check `test`

- `test.command` must `cd` into this run's worktree. Rewrite the path when the worktree changed.
- It must start everything the screen needs (see above). A front-end dev server without its backend is wrong, whatever an earlier run wrote: replace it, with free ports, and set `test.url` to the page.
- Start the command and check that it works: the url answers (`curl -sf -o /dev/null`, 10 tries, one second apart), and so does each backend it started. Keep the stack running for the screenshots.
- Return the checked `test` in the output, changed or not. A `test` that only starts a front-end dev server without its backend is never returned.

## Screenshots

Review captures, once, with the stack already running for the `test` check, after its fixes. Implement leaves `## Screenshots` as `Deferred to review.` (or the list of screens, when it captured).

Nightshift posts these PNGs on the card's pull request. A reviewer reads them to see the change without running the app, so each one must show the change.

- Screens: one PNG per screen this card changes. Name each after what it shows (`02-issue-sources-resync.png`). A capture of the landing page alone does not count unless the change is on it. Keep a screen already listed under `## Screenshots` only when it shows the change; otherwise replace it. Save them in `<worktree>/nightshift-screenshots/`, numbered `01-slug.png`, `02-slug.png`.
- Reach the changed screen. When the change sits behind an interaction (a modal, a settings tab, a menu, a hover) or needs data that the test board lacks, `playwright screenshot <url>` cannot reach it. Do this instead:
  - Seed the data through the app's own API, on the test copy only. Never touch the real board or the shared checkout.
  - Write a short Playwright script outside the worktree: `mktemp -d`, `bun add playwright` there, run it with `node`. The script opens the page, clicks to the screen, waits for the changed element, and screenshots that element or the page.
  - Use a fixed `locale` (for example `en-US`) and the 1280×800 viewport.
  - Delete the script folder afterwards.
- Look at each PNG (Read it) before you list it. A blank page, a spinner, or the wrong screen counts as a missed screenshot: fix it once, else write the reason under `## Screenshots`.
- Playwright: the project's own first: `<worktree>/node_modules/.bin/playwright`, else the board project's; `bunx playwright` when `bun.lock` exists and `package.json` declares `playwright` or `@playwright/test`; else `npx --yes playwright`, which resolves the package on every call. On a missing browser, retry once with `npx --yes playwright`.
- Command: `playwright screenshot --browser chromium --full-page --viewport-size=1280,800 "<url>" "<png>"`. Retry a file once on failure, then write its error under `## Screenshots` and go on: a missed screenshot never fails the card.
- Stop the stack after and leave the ports free. Do not stage the PNGs. Write `## Screenshots` as one markdown image per PNG, absolute path, alt text the screen name (`![Home](/abs/path/nightshift-screenshots/01-home.png)`). With no `test.url`, leave it unchanged.
