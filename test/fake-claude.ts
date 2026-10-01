#!/usr/bin/env bun
// Stand-in for the `claude` CLI: emits stream-json events and a structured result.
// FAKE_DELAY_MS controls run duration; a card titled "fail" produces an error result.
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const title = prompt.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
const delay = Number(process.env.FAKE_DELAY_MS ?? 200);
const emit = (o: unknown) => console.log(JSON.stringify(o));
emit({ type: "system", subtype: "init", session_id: "sess-1", model: "fake" });
emit({ type: "assistant", message: { content: [{ type: "text", text: `Working on ${title}` }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
await Bun.sleep(delay);
const resumed = process.argv.includes("--resume");
if (title === "ask" && !resumed) {
  emit({ type: "result", is_error: false, session_id: "sess-ask", structured_output: { move: "stay", summary: "need input", questions: ["Color?", "Size?"] } });
} else if (resumed) {
  emit({ type: "result", is_error: false, session_id: "sess-ask", structured_output: { title: "answered", description: prompt, move: "next", summary: "resumed" } });
} else if (title === "fail") {
  emit({ type: "result", is_error: true, result: "boom", session_id: "sess-1" });
} else {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-1",
    total_cost_usd: 0.01,
    structured_output: { title: `${title} ✓`, description: "done by fake", move: "next", summary: "fake run" },
  });
}
