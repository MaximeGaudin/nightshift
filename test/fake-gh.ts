import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** State of the fake GitHub behind the fake `gh`: one PR (or none), one release (or none). */
export interface FakeGhState {
  pr?: { url: string; body: string; state: string } | null;
  release?: { assets: { name: string; size: number; url: string }[] } | null;
  failUpload?: boolean;
}

export interface FakeGh {
  /** Executable to put in NIGHTSHIFT_GH. */
  bin: string;
  /** Env vars the fake reads. */
  env: Record<string, string>;
  setState(s: FakeGhState): void;
  state(): FakeGhState;
  /** Every call so far: argv, plus stdin for `pr edit`. */
  calls(): { args: string[]; stdin?: string }[];
}

const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const stateFile = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const st = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(st));
const call = { args };
const [a, b] = args;
if (a === "pr" && b === "edit") call.stdin = await new Response(Bun.stdin.stream()).text();
appendFileSync(process.env.FAKE_GH_JOURNAL, JSON.stringify(call) + "\\n");
const fail = (msg) => { process.stderr.write(msg + "\\n"); process.exit(1); };
if (a === "pr" && b === "view") {
  if (!st.pr) fail("no pull requests found for branch \\"" + args[2] + "\\"");
  console.log(JSON.stringify(st.pr));
} else if (a === "pr" && b === "edit") {
  st.pr.body = call.stdin;
  save();
} else if (a === "release" && b === "view") {
  if (!st.release) fail("release not found");
  console.log(JSON.stringify({ assets: st.release.assets }));
} else if (a === "release" && b === "create") {
  if (st.release) fail("a release with the same tag name already exists");
  st.release = { assets: [] };
  save();
} else if (a === "release" && b === "upload") {
  if (st.failUpload) fail("HTTP 422: upload refused");
  for (const f of args.slice(3).filter((x) => !x.startsWith("--"))) {
    const name = basename(f);
    st.release.assets = st.release.assets.filter((x) => x.name !== name);
    st.release.assets.push({ name, size: statSync(f).size, url: "https://github.test/o/r/releases/download/nightshift-screenshots/" + name });
  }
  save();
} else fail("unknown command " + args.join(" "));
`;

/** Writes a fake `gh` script in `dir`, backed by a JSON state file and a call journal. */
export function makeFakeGh(dir: string, initial: FakeGhState = {}): FakeGh {
  const bin = join(dir, "fake-gh.ts");
  const stateFile = join(dir, "gh-state.json");
  const journal = join(dir, "gh-journal.jsonl");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(stateFile, JSON.stringify(initial));
  writeFileSync(journal, "");
  return {
    bin,
    env: { FAKE_GH_STATE: stateFile, FAKE_GH_JOURNAL: journal },
    setState: (s) => {
      writeFileSync(stateFile, JSON.stringify(s));
      writeFileSync(journal, "");
    },
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    calls: () =>
      existsSync(journal)
        ? readFileSync(journal, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}
