import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BackgroundTasks } from "../src/server/backgroundTasks.ts";

// Real `claude -p` stream (CLI 2.x, trimmed): a Bash command started in the background, an early result, then the
// task notification, a second turn and its result.
const events = readFileSync(join(import.meta.dir, "fixtures", "stream-background.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { type: string; subtype?: string });

test("bg-stream-fixture: the real stream opens the task at its start and closes it at its notification", () => {
  const t = new BackgroundTasks();
  const openAtResult: string[][] = [];
  for (const ev of events) {
    if (ev.type === "result") openAtResult.push(t.openCommands());
    else t.onEvent(ev);
  }
  expect(openAtResult).toEqual([["sleep 20; echo done"], []]);
  expect(t.openCommands()).toEqual([]);
});

test("bg-stream-fixture: each closing signal alone ends the task", () => {
  const start = events.filter((e) => e.type === "assistant" || e.subtype === "task_started" || e.type === "user").slice(0, 3);
  const closers: unknown[] = [
    { type: "system", subtype: "task_notification", task_id: "bb1b9nyl4", status: "killed" },
    { type: "system", subtype: "task_updated", task_id: "bb1b9nyl4", patch: { status: "killed" } },
    { type: "system", subtype: "background_tasks_changed", tasks: [] },
    { type: "user", message: { role: "user", content: "<task-notification>\n<task-id>bb1b9nyl4</task-id>\n<status>killed</status>" } },
  ];
  for (const closer of closers) {
    const t = new BackgroundTasks();
    for (const ev of start) t.onEvent(ev);
    expect(t.openCommands()).toEqual(["sleep 20; echo done"]);
    t.onEvent(closer);
    expect(t.openCommands()).toEqual([]);
  }
});

test("bg-stream-fixture: a foreground call moved to the background after its timeout is tracked", () => {
  const t = new BackgroundTasks();
  t.onEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "bash scripts/run_test_affected.sh" } }] },
  });
  t.onEvent({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu1",
          content:
            "Command did not complete within its 120s timeout and was moved to the background (ID: bzqqs3t0d). Output is being written to: /tmp/x.",
        },
      ],
    },
  });
  expect(t.openCommands()).toEqual(["bash scripts/run_test_affected.sh"]);
  t.onEvent({ type: "system", subtype: "task_started", task_id: "other", tool_use_id: "unknown", is_backgrounded: true });
  expect(t.openCommands()).toEqual(["bash scripts/run_test_affected.sh"]);
});
