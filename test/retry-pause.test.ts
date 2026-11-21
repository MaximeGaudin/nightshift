import { afterAll, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../src/server/orchestrator.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterAll(() => {
  setSystemTime();
  removeTempDirs();
});

// A retry lets a card start while its project is paused, but only in the column it was retried in. HTTP calls are
// often handled in the same millisecond, so the clock is frozen: the move keeps the retry's enteredColumnAt.
test("retry-pause-same-ms-move: a retried card moved in the same millisecond waits for play", async () => {
  const dir = tempDir("ns-retry-pause-");
  const card = { id: "card_a", number: 1, title: "a", description: "", columnId: "col_a", history: [] };
  const at = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "t",
      nextCardNumber: 2,
      columns: [
        { id: "col_a", name: "A", type: "skill", skill: "enrich" },
        { id: "col_b", name: "B", type: "skill", skill: "enrich" },
        { id: "col_done", name: "Done", type: "inert" },
      ],
      cards: [{ ...card, createdAt: at, updatedAt: at, enteredColumnAt: at }],
    }),
  );
  const orch = new Orchestrator();
  const p = orch.open(dir);
  orch.flow.setPaused(p, true);
  expect(orch.snapshot(p).live.card_a).toBe("paused");
  // No await between the calls: the scheduler only runs once the card sits in an inert column, even when an
  // assertion fails (a retried card left in a skill column would start a real agent run).
  setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  try {
    orch.retry(p, "card_a");
    expect(orch.snapshot(p).live.card_a).toBe("queued");
    p.mutate((board) => p.moveCard(board, "card_a", "col_b", undefined, "Moved by user"));
    expect(p.card("card_a")?.enteredColumnAt).toBe("2026-06-01T12:00:00.000Z");
    expect(orch.snapshot(p).live.card_a).toBe("paused");
  } finally {
    p.mutate((board) => p.moveCard(board, "card_a", "col_done", undefined, "Moved by user"));
    setSystemTime();
  }
  await orch.shutdown();
});
