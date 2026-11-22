// The fake gh state file under concurrent writers: overlapping `gh` calls and `fake.setState` never lose a write.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { installFakeGh, removeTempDirs, waitFor } from "./helpers.ts";

afterAll(() => removeTempDirs());

/** A `gh pr create` for `head` that sleeps `delayMs` between reading the state and writing it. */
function slowCreate(fake: ReturnType<typeof installFakeGh>, head: string, delayMs: number) {
  const proc = Bun.spawn([join(fake.dir, "gh"), "pr", "create", "--base", "main", "--head", head, "--title", head], {
    env: { ...process.env, ...fake.env, FAKE_GH_DELAY_MS: String(delayMs) },
    stdout: "ignore",
    stderr: "pipe",
  });
  return proc.exited;
}

test("fake gh: two overlapping pr create keep both pull requests", async () => {
  const fake = installFakeGh({ prs: [], nextNumber: 1 });
  const codes = await Promise.all([slowCreate(fake, "a", 300), slowCreate(fake, "b", 300)]);
  expect(codes).toEqual([0, 0]);
  const prs = fake.state().prs as { head: string; number: number }[];
  expect(prs.map((p) => p.head).sort()).toEqual(["a", "b"]);
  expect(new Set(prs.map((p) => p.number)).size).toBe(2);
});

test("fake gh: setState during a slow write is not overwritten by the stale state", async () => {
  const fake = installFakeGh({ prs: [], nextNumber: 1 });
  const done = slowCreate(fake, "late", 400);
  // Logged once it holds the lock and has read the state: setState now overlaps its write.
  await waitFor(() => fake.calls().length === 1, 10_000);
  fake.setState({ prs: [], nextNumber: 500 });
  expect(await done).toBe(0);
  expect(fake.state()).toEqual({ prs: [], nextNumber: 500 });
});

test("fake gh: setState does not wait on a gh call whose stdin the test process has not written yet", async () => {
  const fake = installFakeGh({ prs: [], nextNumber: 1 });
  // Like src/server/codehost/gh.ts: node spawn, the body written to stdin asynchronously.
  const proc = spawn(join(fake.dir, "gh"), ["pr", "create", "--base", "main", "--head", "piped", "--body-file", "-"], {
    env: { ...process.env, ...fake.env },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise<number | null>((r) => proc.on("close", r));
  await Bun.sleep(300);
  proc.stdin?.end("body");
  const t0 = Date.now();
  fake.setState({ prs: [], nextNumber: 7 });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await exited).toBe(0);
  expect(fake.state().prs.map((p: { head: string; number: number }) => [p.head, p.number])).toEqual([["piped", 7]]);
});
