import { expect, test } from "bun:test";

// Guards against file-order dependence: on Linux progress-prompts.test.ts runs before nightshift.test.ts and loads
// settings.ts and skills.ts first, which then capture the preload's home and user skills directories.
// The child must not inherit NIGHTSHIFT_HOME / NIGHTSHIFT_USER_SKILLS, or preload.ts (`??=`) would reuse ours.
test("test-order-progress-prompts-first: nightshift.test.ts passes after progress-prompts.test.ts", async () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NIGHTSHIFT_HOME;
  delete env.NIGHTSHIFT_USER_SKILLS;
  const proc = Bun.spawn([process.execPath, "test", "./test/progress-prompts.test.ts", "./test/nightshift.test.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const all = out + err;
  if (code !== 0 || !all.includes(" 0 fail")) console.error(all);
  expect(code).toBe(0);
  expect(all).toContain(" 0 fail");
}, 120000);
