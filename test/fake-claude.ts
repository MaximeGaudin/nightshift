#!/usr/bin/env bun
// Stand-in for the `claude` CLI: emits stream-json events and a structured result.
// FAKE_DELAY_MS controls run duration; FAKE_HOLD_FILE, when set, replaces that final wait of card runs: the run ends only
// once that file exists (30 s at most), so a test reads the live run then releases it. A card titled "fail" produces an error result,
// "slow" sleeps FAKE_SLOW_MS (5000 by default) before the normal result, "stay" returns move "stay",
// "progress" emits a TodoWrite, a progress marker, then another TodoWrite; "progress-todo" only a TodoWrite,
// "progress-none" only a Bash tool_use with a description, "progress-marker-after-tool" a tool_use, a marker, a tool_use,
// "progress-activity-subagent" a main tool_use then a subagent one, "progress-subagent" a marker then subagent events that must be ignored.
// In --resume mode the prompt may contain FAKE_MOVE=<value> (move), FAKE_ASK (one question), FAKE_FAIL (error result)
// or FAKE_SLOW (sleeps FAKE_SLOW_MS first).
// Quick runs: the instruction may contain FAKE_QUICK_ERROR (error status), FAKE_QUICK_INVALID (no status),
// FAKE_QUICK_SLOW (sleeps FAKE_SLOW_MS) or FAKE_QUICK_PROGRESS (emits a progress marker 1/2); otherwise success echoing it.
// FAKE_EXTRA_OUTPUT, when set, is a JSON object merged into the structured output of card runs (default and "stay").
// FAKE_ARGS_LOG, when set, receives one JSON line per run: { title, resumed, continuing, resumeId, model, ... }.
// FAKE_ENV_LOG, when set, receives one JSON line per run: { title, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ANTHROPIC_BASE_URL }.
// A card titled "rate-limit" emits a rate_limit_event (5 h 38 %, 7 d 88 %); "rate-limit-bad" emits a malformed one.
// A card titled "tokens-<n>" reports n context tokens in its assistant usage; "usage-multi" reports several (see usageOf).
// FAKE_UNKNOWN_SESSION in the prompt of a continuing run answers like claude for a session it does not have.
// Smart calls (prompt starting with <nightshift-smart>) never write FAKE_ARGS_LOG: they write { title, argv, prompt } to
// FAKE_SMART_LOG and answer in --output-format json. The card title drives them: "smart-fail" (error result),
// "smart-slow" (sleeps 10 s), "smart-invalid" (effort max); otherwise mcp on, effort high, cost 0.0012.
// Background commands: "bg-open" starts a Bash command in the background and returns move "next" without waiting, on every
// launch (resumed too); "bg-open-once" does it only at the first launch; "bg-closed" starts it and gets its
// <task-notification> before the result; "bg-subagent" starts it from a subagent (parent_tool_use_id set).
// Real background processes: "realbg" starts, each detached in its own process group like Claude Code's Bash commands,
// a bun child and a `/bin/sh` running `sleep`, appends their pids (bun, sh, sleep) to FAKE_BG_PID_FILE, then sleeps
// FAKE_SLOW_MS before its result; "realbg-exit" waits FAKE_BG_LINGER_MS (2500), returns its result and leaves them running.
// A card title containing FAKE_KEEP_DESC leaves the description alone; FAKE_SECTIONS adds a "Result" section instead.
// Briefing calls (prompt starting with <nightshift-briefing-…>) write { kind, argv, prompt } to FAKE_BRIEFING_LOG. Triage: a card
// whose title contains "easy" is easy, cards sharing a "[group]" tag form one topic, "triage-fail" fails the call. First turn of
// a topic: one question per card (options A/B, A recommended), or ready at once when a title contains "no-questions";
// "brief-fail" fails it, "brief-slow" sleeps FAKE_SLOW_MS first. Later turns: ready with a decision per answer and an
// Acceptance note per card, unless the owner's message contains FAKE_BRIEF_ASK (one more question) or FAKE_BRIEF_FAIL.
import { appendFileSync, existsSync } from "node:fs";

// Nightshift sends the prompt on stdin (never argv).
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
const delay = Number(process.env.FAKE_DELAY_MS ?? 200);
const slowDelay = Number(process.env.FAKE_SLOW_MS ?? 5000);
if (prompt.startsWith("<nightshift-smart>")) {
  if (process.env.FAKE_SMART_LOG) {
    appendFileSync(process.env.FAKE_SMART_LOG, `${JSON.stringify({ title, argv: process.argv.slice(2), prompt })}\n`);
  }
  if (title.includes("smart-slow")) await Bun.sleep(10_000);
  const result = title.includes("smart-fail")
    ? { type: "result", is_error: true, result: "smart boom", total_cost_usd: 0.0005 }
    : {
        type: "result",
        is_error: false,
        total_cost_usd: 0.0012,
        structured_output: {
          mcp: true,
          chrome: false,
          hooks: false,
          userSettings: true,
          effort: title.includes("smart-invalid") ? "max" : "high",
          reason: "fake smart",
        },
      };
  console.log(JSON.stringify(result));
  process.exit(0);
}
const briefingKind = /^<nightshift-briefing-(triage|topic|turn)>/.exec(prompt)?.[1];
if (briefingKind) {
  if (process.env.FAKE_BRIEFING_LOG) {
    appendFileSync(process.env.FAKE_BRIEFING_LOG, `${JSON.stringify({ kind: briefingKind, argv: process.argv.slice(2), prompt })}\n`);
  }
  const out = (o: unknown) => console.log(JSON.stringify(o));
  const cards = [...prompt.matchAll(/<card ref="(#\d+)"[^>]*>\n<title>([\s\S]*?)<\/title>/g)].map((m) => ({
    ref: m[1] ?? "",
    title: m[2] ?? "",
  }));
  const session = briefingKind === "triage" ? "sess-triage" : `sess-brief-${cards.map((c) => c.ref.slice(1)).join("-") || "turn"}`;
  const resumeIndex = process.argv.indexOf("--resume");
  out({ type: "system", subtype: "init", session_id: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : session, model: "fake" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } });
  const all = cards.map((c) => c.title).join(" ");
  if (all.includes("brief-slow") && briefingKind === "topic") await Bun.sleep(Number(process.env.FAKE_SLOW_MS ?? 5000));
  else await Bun.sleep(Number(process.env.FAKE_DELAY_MS ?? 200));
  const done = (structured_output: unknown) =>
    out({
      type: "result",
      is_error: false,
      session_id: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : session,
      total_cost_usd: 0.002,
      structured_output,
    });
  if (briefingKind === "triage") {
    if (all.includes("triage-fail")) out({ type: "result", is_error: true, result: "triage boom" });
    else {
      const groups = new Map<string, string[]>();
      for (const c of cards) {
        const tag = /\[([^\]]+)\]/.exec(c.title)?.[1];
        if (tag && !c.title.includes("easy")) groups.set(tag, [...(groups.get(tag) ?? []), c.ref]);
      }
      done({
        cards: cards.map((c) => ({
          ref: c.ref,
          verdict: c.title.includes("easy") ? "easy" : "decide",
          reason: c.title.includes("easy") ? "fake: nothing to decide" : "fake: needs a decision",
          ...(c.title.includes("easy") ? { plan: `fake plan for ${c.ref}` } : {}),
        })),
        topics: [...groups].map(([tag, refs]) => ({ title: `Topic ${tag}`, refs, why: `fake: all about ${tag}` })),
      });
    }
  } else if (briefingKind === "topic") {
    if (all.includes("brief-fail")) out({ type: "result", is_error: true, result: "brief boom", session_id: session });
    else if (all.includes("no-questions")) {
      done({
        reply: "Nothing to decide.",
        questions: [],
        decisions: [],
        ready: true,
        notes: cards.map((c) => ({ ref: c.ref, sections: [{ heading: "Acceptance", content: "- works" }] })),
      });
    } else {
      done({
        reply: `Context for ${cards.map((c) => c.ref).join(", ")}.`,
        questions: cards.map((c, i) => ({
          id: `q${i + 1}`,
          question: `Which way for ${c.ref}?`,
          why: "fake: changes the behaviour",
          options: [{ label: "A", detail: "the simple way" }, { label: "B" }],
          recommended: 0,
          cards: [c.ref],
        })),
        decisions: [],
        ready: false,
      });
    }
  } else {
    const refs = [...new Set(prompt.match(/#\d+/g) ?? [])];
    const answers = [...prompt.matchAll(/- \[(\w+)\] (.*)\n {2}Answer: (.*)/g)].map((m) => ({ question: m[2] ?? "", answer: m[3] ?? "" }));
    if (prompt.includes("FAKE_BRIEF_FAIL")) out({ type: "result", is_error: true, result: "turn boom" });
    else if (prompt.includes("FAKE_BRIEF_ASK")) {
      done({
        reply: "One more thing.",
        questions: [{ id: "q9", question: "And the colour?", options: [{ label: "Red" }, { label: "Blue" }], recommended: 1 }],
        decisions: answers.map((a) => ({ ...a, cards: refs })),
        ready: false,
      });
    } else {
      done({
        reply: "All settled.",
        questions: [],
        decisions: prompt.includes("settle the rest yourself")
          ? [{ question: "Everything left", answer: "Agent's call: A", cards: refs }]
          : answers.map((a) => ({ ...a, cards: refs })),
        ready: true,
        notes: refs.map((ref) => ({ ref, sections: [{ heading: "Acceptance", content: `- ${ref} works as decided` }] })),
      });
    }
  }
  process.exit(0);
}
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
      fastMerge: prompt.includes("<fast-merge>"),
      prompt,
    })}\n`,
  );
}
if (process.env.FAKE_ENV_LOG) {
  const { HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ANTHROPIC_BASE_URL } = process.env;
  appendFileSync(process.env.FAKE_ENV_LOG, `${JSON.stringify({ title, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ANTHROPIC_BASE_URL })}\n`);
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
const bgScenario = title.startsWith("bg-")
  ? title
  : resumed && prompt.includes("background commands you started were still running")
    ? (prompt.match(/# (bg-[a-z-]+)/)?.[1] ?? "")
    : "";
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
  // The test reads the state before the next event in this window: no later event exists to wait on.
  await Bun.sleep(500);
  emit({ type: "assistant", message: { content: [{ type: "text", text: "[nightshift-progress] 1/3 A" }] } });
  emit(tool("Last tool")); // after a marker: must not revert to activity
} else if (title === "progress-activity-subagent") {
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "Main tool" } }] },
  });
  // The test reads the state before the next event in this window: no later event exists to wait on.
  await Bun.sleep(500);
  emit({
    type: "assistant",
    parent_tool_use_id: "toolu_1",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "Sub tool" } }] },
  });
} else if (title === "progress-todo") {
  emit(todos("in_progress", "pending"));
}
if (title === "realbg" || title === "realbg-exit") {
  const pidFile = process.env.FAKE_BG_PID_FILE ?? "/dev/null";
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  appendFileSync(pidFile, `${child.pid}\n`);
  const shell = Bun.spawn(["/bin/sh", "-c", `echo $$ >> '${pidFile}'; sleep 999 & echo $! >> '${pidFile}'; wait`], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  shell.unref();
  // "realbg-exit" outlives one tracker tick of the run registry first, like a claude that ran for a while.
  await Bun.sleep(title === "realbg" ? slowDelay : Number(process.env.FAKE_BG_LINGER_MS ?? 2500));
}
const holdFile = process.env.FAKE_HOLD_FILE;
if (holdFile && !quick) {
  // Held: the run stays live until the test creates the file (30 s at most, so a broken test leaks no process).
  const end = Date.now() + 30_000;
  while (!existsSync(holdFile) && Date.now() < end) await Bun.sleep(20);
} else {
  await Bun.sleep(
    title === "slow" || (quick && instruction.includes("FAKE_QUICK_SLOW")) || (resumed && prompt.includes("FAKE_SLOW")) ? slowDelay : delay,
  );
}
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
} else if (bgScenario) {
  // A Bash command left running in the background (see the header). Its command names the scenario, so the resumed
  // run, whose prompt has no <title>, finds it in the wait prompt.
  if (!(resumed && bgScenario === "bg-open-once")) {
    const parent = bgScenario === "bg-subagent" ? "tu-agent" : null;
    emit({
      type: "assistant",
      parent_tool_use_id: parent,
      message: {
        content: [
          { type: "tool_use", id: "tu-bg", name: "Bash", input: { command: `sleep 999 # ${bgScenario}`, run_in_background: true } },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: parent,
      tool_use_result: { backgroundTaskId: "bg1" },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-bg",
            content: "Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output.",
          },
        ],
      },
    });
    if (bgScenario === "bg-closed") {
      emit({
        type: "user",
        message: { role: "user", content: "<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>" },
      });
    }
  }
  emit({ type: "result", is_error: false, session_id: "sess-bg", structured_output: { move: "next", summary: `${bgScenario} done` } });
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
  emit({ type: "result", is_error: false, session_id: "sess-1", structured_output: { move: "stay", summary: "stayed", ...extra } });
} else {
  emit({
    type: "result",
    is_error: false,
    session_id: "sess-1",
    total_cost_usd: 0.01,
    structured_output: {
      title: `${title} ✓`,
      ...(title.includes("FAKE_KEEP_DESC")
        ? {}
        : title.includes("FAKE_SECTIONS")
          ? { sections: [{ heading: "Result", content: "done by fake" }] }
          : { description: "done by fake" }),
      move: "next",
      summary: "fake run",
      ...(title === "js-url" ? { test: { command: "echo hi", url: "javascript:alert(1)" } } : {}),
      ...(title === "bad-url" ? { test: { command: "echo hi", url: 123 } } : {}),
      ...extra,
      ...(title === "with-test" ? { test: { command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" } } : {}),
    },
  });
}
