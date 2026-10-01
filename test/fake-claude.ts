#!/usr/bin/env bun
// Stand-in for the `claude` CLI: emits stream-json events and a structured result.
// FAKE_DELAY_MS controls run duration; a card titled "fail" produces an error result,
// "slow" sleeps ~5 s before the normal result, "stay" returns move "stay",
// "progress" emits a TodoWrite, a progress marker, then another TodoWrite; "progress-todo" only a TodoWrite,
// "progress-none" only a Bash tool_use with a description, "progress-marker-after-tool" a tool_use, a marker, a tool_use,
// "progress-activity-subagent" a main tool_use then a subagent one, "progress-subagent" a marker then subagent events that must be ignored.
// In --resume mode the prompt may contain FAKE_MOVE=<value> (move), FAKE_ASK (one question), FAKE_FAIL (error result)
// or FAKE_SLOW (sleeps ~5 s first).
// FAKE_ARGS_LOG, when set, receives one JSON line per run: { title, resumed, model }.
import { appendFileSync } from "node:fs";

// Nightshift sends the prompt on stdin (never argv).
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
const delay = Number(process.env.FAKE_DELAY_MS ?? 200);
const resumed = process.argv.includes("--resume");
const modelAt = process.argv.indexOf("--model");
if (process.env.FAKE_ARGS_LOG) {
  appendFileSync(
    process.env.FAKE_ARGS_LOG,
    `${JSON.stringify({
      title,
      resumed,
      model: modelAt >= 0 ? process.argv[modelAt + 1] : null,
      argvHasCard: process.argv.some((a) => a.includes("<card")),
    })}\n`,
  );
}
const emit = (o: unknown) => console.log(JSON.stringify(o));
emit({ type: "system", subtype: "init", session_id: "sess-1", model: "fake" });
emit({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: `Working on ${title}` },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ],
  },
});
const todos = (...status: string[]) => ({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        name: "TodoWrite",
        input: { todos: status.map((s, i) => ({ content: `Tâche ${i + 1}`, activeForm: `Tâche ${i + 1} en cours`, status: s })) },
      },
    ],
  },
});
if (title === "progress") {
  emit(todos("in_progress", "pending"));
  emit({ type: "assistant", message: { content: [{ type: "text", text: "[nightshift-progress] 2/3 Deuxième" }] } });
  emit(todos("completed", "in_progress")); // ignored: the marker has priority
} else if (title === "progress-subagent") {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "[nightshift-progress] 1/2 Principal" }] } });
  // Subagent events (parent_tool_use_id set) must not drive the card's progress.
  emit({ ...todos("completed", "in_progress"), parent_tool_use_id: "toolu_1" });
  emit({
    type: "assistant",
    parent_tool_use_id: "toolu_1",
    message: { content: [{ type: "text", text: "[nightshift-progress] 5/9 Sous-agent" }] },
  });
} else if (title === "progress-none") {
  // No marker, no TodoWrite: only tool calls, the card falls back to the activity progress.
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test", description: "Run the tests" } }] },
  });
} else if (title === "progress-marker-after-tool") {
  const tool = (description: string, extra: object = {}) => ({
    type: "assistant",
    ...extra,
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description } }] },
  });
  emit(tool("First tool"));
  await Bun.sleep(500);
  emit({ type: "assistant", message: { content: [{ type: "text", text: "[nightshift-progress] 1/3 A" }] } });
  await Bun.sleep(500);
  emit(tool("Last tool")); // after a marker: must not revert to activity
} else if (title === "progress-activity-subagent") {
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "Main tool" } }] },
  });
  await Bun.sleep(500);
  emit({
    type: "assistant",
    parent_tool_use_id: "toolu_1",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "Sub tool" } }] },
  });
} else if (title === "progress-todo") {
  emit(todos("in_progress", "pending"));
}
await Bun.sleep(title === "slow" || (resumed && prompt.includes("FAKE_SLOW")) ? 5000 : delay);
if (title === "no-output" && !resumed) {
  // Finished its turn without the structured result (e.g. only interim results while background work ran).
  emit({ type: "result", is_error: false, subtype: "success", result: "", session_id: "sess-1" });
} else if (title === "die" && !resumed) {
  process.exit(137); // killed mid-run: no result event at all
} else if (title === "ask" && !resumed) {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-ask",
    structured_output: { move: "stay", summary: "need input", questions: ["Color?", "Size?"] },
  });
} else if (resumed && prompt.includes("FAKE_FAIL")) {
  emit({ type: "result", is_error: true, result: "feedback boom", session_id: "sess-fb" });
} else if (resumed && prompt.includes("FAKE_ASK")) {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-fb",
    structured_output: { move: "stay", summary: "need input", questions: ["Which one?"] },
  });
} else if (resumed && /FAKE_MOVE=/.test(prompt)) {
  const move = prompt.match(/FAKE_MOVE=(\S+)/)?.[1] ?? "stay";
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-fb",
    structured_output: { title: "feedback done", description: prompt, move, summary: "feedback applied" },
  });
} else if (resumed) {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-ask",
    structured_output: { title: "answered", description: prompt, move: "next", summary: "resumed" },
  });
} else if (title === "fail") {
  emit({ type: "result", is_error: true, result: "boom", session_id: "sess-1" });
} else if (title === "stay") {
  emit({ type: "result", is_error: false, session_id: "sess-1", structured_output: { move: "stay", summary: "stayed" } });
} else {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-1",
    total_cost_usd: 0.01,
    structured_output: {
      title: `${title} ✓`,
      description: "done by fake",
      move: "next",
      summary: "fake run",
      ...(title === "js-url" ? { test: { command: "echo hi", url: "javascript:alert(1)" } } : {}),
      ...(title === "bad-url" ? { test: { command: "echo hi", url: 123 } } : {}),
      ...(title === "with-test" ? { test: { command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" } } : {}),
    },
  });
}
