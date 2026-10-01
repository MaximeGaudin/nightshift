import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { safeHttpUrl } from "../src/shared/urls.ts";
import { addAgentCard, type ChildServer, startChildServer, waitFor } from "./helpers.ts";

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50" },
  });
});
afterAll(() => srv.stop());

test("test-url-helper: only absolute http(s) URLs without spaces or control characters", () => {
  expect(safeHttpUrl("http://localhost:3000")).toBe("http://localhost:3000");
  expect(safeHttpUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "//evil.com",
    "/relative",
    "http://",
    "http://a b",
    " http://a.com",
    "http://a.com\n",
    "java\tscript:alert(1)",
    "",
    123,
    undefined,
    null,
  ]) {
    expect(safeHttpUrl(bad)).toBeNull();
  }
});

test("test-url-put: javascript: url is refused with 400 and the previous test is kept", async () => {
  const { dir, id, card } = await addAgentCard(srv, "stay");
  await waitFor(async () => !!(await card())?.lastRun);
  const put = (body: object) => srv.call(`/api/cards/${id}/test`, { method: "PUT", body: { project: dir, ...body } });
  expect((await put({ command: "bun dev", url: "http://localhost:3000" })).status).toBe(200);
  const bad = await put({ command: "evil", url: "javascript:alert(1)" });
  expect(bad.status).toBe(400);
  expect((await put({ command: "evil", url: 5 })).status).toBe(400);
  expect((await card()).test).toEqual({ command: "bun dev", url: "http://localhost:3000" });
  expect((await put({ command: "bun dev", url: "" })).status).toBe(200);
  expect((await card()).test).toEqual({ command: "bun dev" });
});

test("test-url-agent: agent output with a javascript: url keeps the command and drops the url", async () => {
  const { card } = await addAgentCard(srv, "js-url");
  await waitFor(async () => !!(await card())?.lastRun);
  const c = await card();
  expect(c.lastRun.status).toBe("success");
  expect(c.test.command).toBe("echo hi");
  expect(c.test.url).toBeUndefined();
});
