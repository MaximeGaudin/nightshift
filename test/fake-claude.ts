#!/usr/bin/env bun
// Stand-in for the `claude` CLI: emits stream-json events and a structured result.
// FAKE_DELAY_MS controls run duration; a card titled "fail" produces an error result,
// "slow" sleeps ~5 s before the normal result, "stay" returns move "stay".
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
    JSON.stringify({ title, resumed, model: modelAt >= 0 ? process.argv[modelAt + 1] : null, argvHasCard: process.argv.some((a) => a.includes("<card")) }) + "\n",
  );
}
const emit = (o: unknown) => console.log(JSON.stringify(o));
emit({ type: "system", subtype: "init", session_id: "sess-1", model: "fake" });
emit({ type: "assistant", message: { content: [{ type: "text", text: `Working on ${title}` }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
await Bun.sleep(title === "slow" ? 5000 : delay);
if (title === "no-output" && !resumed) {
  // Finished its turn without the structured result (e.g. only interim results while background work ran).
  emit({ type: "result", is_error: false, subtype: "success", result: "", session_id: "sess-1" });
} else if (title === "die" && !resumed) {
  process.exit(137); // killed mid-run: no result event at all
} else if (title === "ask" && !resumed) {
  emit({ type: "result", is_error: false, session_id: "sess-ask", structured_output: { move: "stay", summary: "need input", questions: ["Color?", "Size?"] } });
} else if (resumed) {
  emit({ type: "result", is_error: false, session_id: "sess-ask", structured_output: { title: "answered", description: prompt, move: "next", summary: "resumed" } });
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
      ...(title === "with-test" ? { test: { command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" } } : {}),
    },
  });
}
