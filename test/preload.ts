import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale } from "../src/web/i18n/index.ts";

// Safety net for every test file: settings.ts reads NIGHTSHIFT_HOME at import, so a file that forgets to set it
// would write into the real ~/.nightshift. Files that need their own home set it before importing the server
// modules (or run the server in a child process with test/helpers.ts).
const created: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
process.env.NIGHTSHIFT_HOME ??= fresh("ns-test-home-");
process.env.NIGHTSHIFT_USER_SKILLS ??= fresh("ns-test-skills-");
// The CPU throttle reads the machine's real load otherwise: a busy machine (parallel test groups, other agents)
// would hold cards back and time out tests that start agents in this process. A missing file means "load unknown".
process.env.NIGHTSHIFT_CPU_LOAD_FILE ??= join(fresh("ns-test-cpu-"), "cpu-load");
// A developer shell or an agent running behind teamclaude exports a proxy: fake agents would inherit it and the
// tests that assert "no proxy variable" would measure the ambient environment instead of what Nightshift injects.
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY", "all_proxy"])
  delete process.env[k];
// Under an AI agent (these variables), `bun test` prints a short report without the "(pass) name" lines. Agents run
// this suite, and the tests that start `bun test` in a child process read those lines: children get a plain environment.
for (const k of ["CLAUDECODE", "AGENT", "REPL_ID"]) delete process.env[k];
// Do not leave these two folders in /tmp after every run.
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// UI tests assert the French strings; the app itself resolves the locale from the browser or the setting.
setLocale("fr");
