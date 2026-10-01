import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Safety net for every test file: settings.ts reads NIGHTSHIFT_HOME at import, so a file that forgets to set it
// would write into the real ~/.nightshift. Files that need their own home set it before importing the server
// modules (or run the server in a child process with test/helpers.ts).
process.env.NIGHTSHIFT_HOME ??= mkdtempSync(join(tmpdir(), "ns-test-home-"));
process.env.NIGHTSHIFT_USER_SKILLS ??= mkdtempSync(join(tmpdir(), "ns-test-skills-"));
