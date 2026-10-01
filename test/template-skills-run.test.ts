import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type ChildServer, startChildServer, tempDir, waitFor } from "./helpers.ts";

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50", NIGHTSHIFT_TEMPLATE_SKILLS: join(import.meta.dir, "..", ".claude", "skills") },
  });
});
afterAll(() => srv.stop());

test("template-skills-run: a card in Grill of a new project finds the copied skill", async () => {
  // srv.skills (NIGHTSHIFT_USER_SKILLS) is an empty directory: only the project copy can satisfy the lookup.
  const dir = tempDir("ns-tpl-run-");
  const snap = await srv.call("/api/projects/open", { body: { path: dir } }).then((r) => r.json());
  const grill = snap.board.columns.find((c: { name: string }) => c.name === "Grill");
  const { id } = await srv.call("/api/cards", { body: { project: dir, columnId: grill.id, title: "hello" } }).then((r) => r.json());
  const card = async () => {
    const s = await srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    return s.board.cards.find((c: { id: string }) => c.id === id);
  };
  await waitFor(async () => !!(await card())?.lastRun);
  const c = await card();
  expect(c.lastRun.error ?? "").not.toContain("not found in project or user skills");
});
