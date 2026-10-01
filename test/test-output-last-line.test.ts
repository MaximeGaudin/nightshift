import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer, waitFor } from "./helpers.ts";

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer();
});
afterAll(() => srv.stop());

async function runTest(command: string) {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  const q = `?project=${encodeURIComponent(dir)}`;
  await srv.call("/api/projects/open", { body: { path: dir } });
  const snap = await srv.call(`/api/project${q}`).then((r) => r.json());
  const { id } = await srv
    .call("/api/cards", { body: { project: dir, columnId: snap.board.columns[0].id, title: "t" } })
    .then((r) => r.json());
  await srv.call(`/api/cards/${id}/test`, { method: "PUT", body: { project: dir, command } });
  await srv.call(`/api/cards/${id}/test/start`, { body: { project: dir } });
  const log = async (): Promise<{ kind: string; text: string }[]> => srv.call(`/api/cards/${id}/test${q}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l) => l.text.startsWith("Exited")));
  return log();
}

test("test-output-last-line: output without trailing newline is kept, before the Exited line", async () => {
  const lines = await runTest("printf out; printf err >&2");
  const texts = lines.map((l) => l.text);
  expect(texts).toContain("out");
  expect(texts).toContain("err");
  expect(texts.findIndex((t) => t.startsWith("Exited"))).toBe(texts.length - 1);
});

test("test-output-last-line: lines ending with a newline still work", async () => {
  const lines = await runTest("printf 'a\\nb\\nc'");
  expect(lines.filter((l) => l.kind === "text").map((l) => l.text)).toEqual(["a", "b", "c"]);
});
