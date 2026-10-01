import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

function skill(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
}

test("favorite-toggle-rewrites-list", async () => {
  const srv = await startChildServer();
  try {
    skill(srv.skills, "build");
    skill(srv.skills, "deploy");
    const dir = tempDir("ns-fav-");
    // A favorite whose skill no longer exists, written by hand before the project is opened.
    writeFileSync(
      join(dir, "nightshift.json"),
      JSON.stringify({
        version: 1,
        name: "p",
        columns: [{ id: "c1", name: "Todo", type: "inert" }],
        cards: [],
        nextCardNumber: 1,
        favoriteSkills: ["zz-orphan", "deploy"],
      }),
    );
    await srv.call("/api/projects/open", { body: { path: dir } });
    const favorites = () => JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8")).favoriteSkills;
    const toggle = (name: string, favorite: boolean) =>
      srv.call("/api/favorite-skills", { method: "PUT", body: { project: dir, name, favorite } });

    const checked = await toggle("build", true);
    expect(checked.status).toBe(200);
    expect((await checked.json()).board.favoriteSkills).toEqual(["build", "deploy"]);
    expect(favorites()).toEqual(["build", "deploy"]);

    await toggle("deploy", false);
    expect(favorites()).toEqual(["build"]);
    expect((await toggle("ghost", false)).status).toBe(200);
    await toggle("build", false);
    expect(JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"))).not.toHaveProperty("favoriteSkills");

    expect((await toggle("nope", true)).status).toBe(404);
  } finally {
    await srv.stop();
  }
});
