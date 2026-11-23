import { expect, test } from "bun:test";
import { normalizeBoard } from "../src/server/store.ts";

test("column-ignore-cpu-normalize: only a skill column with true keeps the flag", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "skill", skill: "s", ignoreCpuThrottle: true },
        { id: "b", name: "B", type: "skill", skill: "s", ignoreCpuThrottle: false },
        { id: "c", name: "C", type: "inert", ignoreCpuThrottle: true },
        { id: "col_done", name: "Done", type: "inert", ignoreCpuThrottle: true },
      ],
      cards: [],
    },
    "x",
  );
  const by = (id: string) => b.columns.find((c) => c.id === id);
  expect(by("a")?.ignoreCpuThrottle).toBe(true);
  expect("ignoreCpuThrottle" in (by("b") ?? {})).toBe(false);
  expect("ignoreCpuThrottle" in (by("c") ?? {})).toBe(false);
  for (const c of b.columns.filter((c) => c.id.startsWith("col_"))) expect("ignoreCpuThrottle" in c).toBe(false);
});
