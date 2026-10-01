import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Do not leave these two folders in /tmp after every run.
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
