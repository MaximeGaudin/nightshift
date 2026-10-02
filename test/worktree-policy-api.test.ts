import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

test("worktree-policy-api: forbidden writes the field, required removes it, invalid is 400, unknown project is 404", async () => {
  const srv = await startChildServer();
  try {
    const dir = tempDir("ns-wt-");
    writeFileSync(
      join(dir, "nightshift.json"),
      JSON.stringify({ version: 1, name: "p", columns: [{ id: "c1", name: "Todo", type: "inert" }], cards: [], nextCardNumber: 1 }),
    );
    await srv.call("/api/projects/open", { body: { path: dir } });
    const stored = () => JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8")).worktreePolicy;
    const put = (project: string, policy: unknown) => srv.call("/api/worktree-policy", { method: "PUT", body: { project, policy } });

    const forbidden = await put(dir, "forbidden");
    expect(forbidden.status).toBe(200);
    expect((await forbidden.json()).board.worktreePolicy).toBe("forbidden");
    expect(stored()).toBe("forbidden");

    expect((await put(dir, "auto")).status).toBe(200);
    expect(stored()).toBe("auto");

    const required = await put(dir, "required");
    expect(required.status).toBe(200);
    expect("worktreePolicy" in (await required.json()).board).toBe(false);
    expect(stored()).toBeUndefined();

    expect((await put(dir, "banana")).status).toBe(400);
    expect((await put(dir, 3)).status).toBe(400);
    expect(stored()).toBeUndefined();

    expect((await put(join(dir, "missing"), "auto")).status).toBe(404);
  } finally {
    await srv.stop();
  }
});
