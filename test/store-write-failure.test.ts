import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/server/store.ts";

test("store-write-failure: a failed write throws and leaves memory identical to the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-wf-"));
  try {
    const p = new Project(dir);
    const file = join(dir, "nightshift.json");
    const onDisk = () => JSON.parse(readFileSync(file, "utf8"));
    const first = p.column(p.board.columns[0]!.id)!;
    let notified = 0;
    p.onChange(() => notified++);

    // The temporary file path is a directory: the write cannot succeed (even for root).
    mkdirSync(`${file}.tmp`);
    expect(() =>
      p.mutate((board) => {
        board.name = "changed";
        board.cards.push({
          id: "c1",
          number: 1,
          title: "x",
          description: "",
          columnId: first.id,
          createdAt: "",
          updatedAt: "",
          enteredColumnAt: "",
          history: [],
        });
      }),
    ).toThrow();

    expect(notified).toBe(0);
    expect(p.board.name).not.toBe("changed");
    expect(p.board.cards).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(p.board))).toEqual(onDisk());

    // A later mutation works once the obstacle is gone.
    rmSync(`${file}.tmp`, { recursive: true });
    p.mutate((board) => {
      board.name = "after";
    });
    expect(onDisk().name).toBe("after");
    expect(notified).toBe(1);
    p.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store-write-failure: a mutation that throws is rolled back", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-wf-"));
  try {
    const p = new Project(dir);
    const name = p.board.name;
    expect(() =>
      p.mutate((board) => {
        board.name = "half";
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(p.board.name).toBe(name);
    p.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
