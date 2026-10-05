#!/usr/bin/env bun
// Stand-in for the `claude` CLI: emits stream-json events and a structured result.
// FAKE_DELAY_MS controls run duration; a card titled "fail" produces an error result,
// "slow" sleeps ~5 s before the normal result, "stay" returns move "stay",
// "progress" emits a TodoWrite, a progress marker, then another TodoWrite; "progress-todo" only a TodoWrite,
// "progress-none" only a Bash tool_use with a description, "progress-marker-after-tool" a tool_use, a marker, a tool_use,
// "progress-activity-subagent" a main tool_use then a subagent one, "progress-subagent" a marker then subagent events that must be ignored.
// In --resume mode the prompt may contain FAKE_MOVE=<value> (move), FAKE_ASK (one question), FAKE_FAIL (error result)
// or FAKE_SLOW (sleeps ~5 s first).
// Quick runs: the instruction may contain FAKE_QUICK_ERROR (error status), FAKE_QUICK_INVALID (no status),
// FAKE_QUICK_SLOW (sleeps ~5 s) or FAKE_QUICK_PROGRESS (emits a progress marker 1/2); otherwise success echoing it.
// FAKE_EXTRA_OUTPUT, when set, is a JSON object merged into the structured output of card runs.
// FAKE_ARGS_LOG, when set, receives one JSON line per run: { title, resumed, continuing, resumeId, model, ... }.
// A card titled "rate-limit" emits a rate_limit_event (5 h 38 %, 7 d 88 %); "rate-limit-bad" emits a malformed one.
// A card titled "tokens-<n>" reports n context tokens in its assistant usage; "usage-multi" reports several (see usageOf).
// FAKE_UNKNOWN_SESSION in the prompt of a continuing run answers like claude for a session it does not have.
import { appendFileSync } from "node:fs";

// Nightshift sends the prompt on stdin (never argv).
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
const delay = Number(process.env.FAKE_DELAY_MS ?? 200);
// Quick runs (no card): the prompt carries an instruction block or "no instruction", and the instruction drives the behaviour.
const quick = prompt.includes("<instruction>") || prompt.includes("no instruction");
const instruction = prompt.match(/<instruction>\n([\s\S]*?)\n<\/instruction>/)?.[1] ?? "";
// A new column continuing the card's session also passes --resume, with the column prompt behind a "New step" line:
// it behaves like a fresh run. `resumed` means an answer, feedback or recovery in the same column.
const resumeAt = process.argv.indexOf("--resume");
const resumeId = resumeAt >= 0 ? process.argv[resumeAt + 1] : null;
const continuing = resumeAt >= 0 && prompt.startsWith("New step for this card.");
const resumed = resumeAt >= 0 && !continuing;
const modelAt = process.argv.indexOf("--model");
if (process.env.FAKE_ARGS_LOG) {
  appendFileSync(
    process.env.FAKE_ARGS_LOG,
    `${JSON.stringify({
      title,
      resumed,
      continuing,
      resumeId,
      model: modelAt >= 0 ? process.argv[modelAt + 1] : null,
      argvHasCard: process.argv.some((a) => a.includes("<card")),
      argv: process.argv.slice(2),
      promptHasQuick: quick,
      prompt: quick ? prompt : undefined,
    })}\n`,
  );
}
const extra = process.env.FAKE_EXTRA_OUTPUT ? JSON.parse(process.env.FAKE_EXTRA_OUTPUT) : {};
const emit = (o: unknown) => console.log(JSON.stringify(o));
if (continuing && prompt.includes("FAKE_UNKNOWN_SESSION")) {
  console.log(`No conversation found with session ID: ${resumeId}`);
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [`No conversation found with session ID: ${resumeId}`],
    }),
  );
  process.exit(1);
}
emit({ type: "system", subtype: "init", session_id: "sess-1", model: "fake" });
if (title === "rate-limit") {
  emit({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 1791237600,
      rateLimitType: "seven_day",
      utilization: 0.88,
      isUsingOverage: false,
      surpassedThreshold: 0.75,
      unifiedWindows: {
        five_hour: { utilization: 0.38, resetsAt: 1791193200 },
        seven_day: { utilization: 0.88, resetsAt: 1791237600 },
      },
    },
  });
}
if (title === "rate-limit-bad") {
  emit({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: "x" } }, status: 42 } });
}
emit({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: `Working on ${title}` },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ],
  },
});
// Context size: "tokens-<n>" reports n tokens on its own assistant message; "usage-multi" reports two own messages
// (the last one wins, a missing field counts as 0) around a subagent one that must be ignored.
const usageOf = (usage: object, extra: object = {}) => ({
  type: "assistant",
  ...extra,
  message: { content: [{ type: "text", text: "usage" }], usage },
});
const tokensTitle = title.match(/^tokens-(\d+)/);
if (tokensTitle) emit(usageOf({ input_tokens: 1, cache_read_input_tokens: Number(tokensTitle[1]) - 1 }));
if (title.startsWith("usage-multi")) {
  emit(usageOf({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }));
  emit(usageOf({ input_tokens: 999999 }, { parent_tool_use_id: "toolu_1" }));
  emit(usageOf({ cache_read_input_tokens: 7 }));
}
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
if (quick && instruction.includes("FAKE_QUICK_PROGRESS")) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "[nightshift-progress] 1/2 label" }] } });
} else if (title === "progress") {
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
await Bun.sleep(
  title === "slow" || (quick && instruction.includes("FAKE_QUICK_SLOW")) || (resumed && prompt.includes("FAKE_SLOW")) ? 5000 : delay,
);
if (quick) {
  if (instruction.includes("FAKE_QUICK_ERROR")) {
    emit({ type: "result", is_error: false, session_id: "sess-q", structured_output: { status: "error", summary: "fake quick failure" } });
  } else if (instruction.includes("FAKE_QUICK_INVALID")) {
    emit({ type: "result", is_error: false, session_id: "sess-q", structured_output: { summary: "no status here" } });
  } else {
    emit({
      type: "result",
      is_error: false,
      session_id: "sess-q",
      structured_output: { status: "success", summary: `fake quick run: ${instruction || "no instruction"}` },
    });
  }
} else if (title === "no-output" && !resumed) {
  // Finished its turn without the structured result (e.g. only interim results while background work ran).
  emit({ type: "result", is_error: false, subtype: "success", result: "", session_id: "sess-1" });
} else if (title === "die" && !resumed) {
  process.exit(137); // killed mid-run: no result event at all
} else if (title === "ask" && !resumed) {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-ask",
    structured_output: { move: "stay", summary: "need input", questions: ["Color?", "Size?"], ...extra },
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
      ...extra,
      ...(title === "with-test" ? { test: { command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" } } : {}),
    },
  });
}
