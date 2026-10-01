import { afterAll, beforeAll, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

test("tests-isolation: the test run never targets the real ~/.nightshift", () => {
  expect(process.env.NIGHTSHIFT_HOME).toBeTruthy();
  expect(process.env.NIGHTSHIFT_HOME).not.toBe(join(homedir(), ".nightshift"));
  expect(process.env.NIGHTSHIFT_USER_SKILLS).toBeTruthy();
});

let a: ChildServer;
let b: ChildServer;
beforeAll(async () => {
  [a, b] = await Promise.all([startChildServer(), startChildServer()]);
});
afterAll(() => Promise.all([a.stop(), b.stop()]));

test("tests-isolation: two servers with different NIGHTSHIFT_HOME share neither settings nor projects", async () => {
  expect(a.home).not.toBe(b.home);
  await a.call("/api/settings", { method: "PUT", body: { claudePath: "/tmp/only-in-a" } });
  await a.call("/api/projects/open", { body: { path: a.tmp } });
  const sa = await a.call("/api/settings").then((r) => r.json());
  const sb = await b.call("/api/settings").then((r) => r.json());
  expect(sa.claudePath).toBe("/tmp/only-in-a");
  expect(sb.claudePath).not.toBe("/tmp/only-in-a");
  expect(sa.recentProjects).toContain(a.tmp);
  expect(sb.recentProjects).not.toContain(a.tmp);
});
