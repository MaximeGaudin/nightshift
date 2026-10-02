#!/usr/bin/env bun
// Sandbox to try fast forward and pause by hand: bun scripts/flow-sandbox.ts <dir>
// Writes a demo board in <dir>/board and a Nightshift home in <dir>/home whose claudePath is a fake agent
// (about 8 s per run, then "next"; a card titled with "fail" errors). Start Nightshift WITH agents on it:
//   NIGHTSHIFT_HOME=<dir>/home NIGHTSHIFT_USER_SKILLS=<dir>/user-skills bun bin/nightshift.ts --port <port> <dir>/board
// No real Claude runs and the user's ~/.nightshift is left alone. The sandbox is rebuilt on every call.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Board, Card, Column } from "../src/shared/types.ts";

const target = process.argv[2];
if (!target) {
  console.error("Usage: bun scripts/flow-sandbox.ts <dir>");
  process.exit(2);
}
const dir = resolve(target);
rmSync(dir, { recursive: true, force: true });
const boardDir = join(dir, "board");
const home = join(dir, "home");
mkdirSync(join(boardDir, ".claude", "skills", "demo"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(join(dir, "user-skills"), { recursive: true });
writeFileSync(
  join(boardDir, ".claude", "skills", "demo", "SKILL.md"),
  "---\nname: demo\ndescription: Fake skill for the flow sandbox\n---\n",
);

const fake = join(dir, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\\s\\S]*?)<\\/title>/)?.[1] ?? "";
const e = (o) => console.log(JSON.stringify(o));
const session = "sandbox-" + Math.random().toString(36).slice(2);
e({ type: "system", subtype: "init", session_id: session, model: "fake" });
for (let i = 1; i <= 4; i++) {
  e({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "[nightshift-progress] " + i + "/4 working" }] } });
  await Bun.sleep(2000);
}
if (title.includes("fail")) e({ type: "result", is_error: true, result: "Simulated failure", session_id: session });
else e({ type: "result", is_error: false, session_id: session, structured_output: { move: "next", summary: "Fake run done." } });
`,
);
chmodSync(fake, 0o755);
writeFileSync(join(home, "settings.json"), `${JSON.stringify({ claudePath: fake, soundNotifications: false }, null, 2)}\n`);

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "demo", maxParallel: 2 },
  { id: "col_impl", name: "Implement", type: "skill", skill: "demo", maxParallel: 2 },
  { id: "col_test", name: "To Test", type: "inert" },
  { id: "col_merge", name: "Merge", type: "skill", skill: "demo", maxParallel: 1 },
  { id: "col_done", name: "Done", type: "inert" },
];
const now = new Date().toISOString();
let n = 1;
const card = (title: string, over: Partial<Card> = {}): Card => {
  const number = n++;
  return {
    id: `card_sandbox${number}`,
    number,
    title,
    description: "",
    columnId: "col_backlog",
    createdAt: now,
    updatedAt: now,
    enteredColumnAt: now,
    history: [{ at: now, kind: "created", text: "Created in Backlog", columnId: "col_backlog" }],
    ...over,
  };
};
const cards = [card("Alpha"), card("Bravo"), card("Charlie"), card("Delta will fail")];
cards.push(card("Echo waits for Alpha", { dependsOn: [cards[0].id] }));
const board: Board = { version: 1, name: "Flow sandbox", columns, cards, nextCardNumber: n, maxParallel: 3 };
writeFileSync(join(boardDir, "nightshift.json"), `${JSON.stringify(board, null, 2)}\n`);
console.log(`Sandbox ready: board ${boardDir}, home ${home}`);
