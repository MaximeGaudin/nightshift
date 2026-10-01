import { expect, test } from "bun:test";
import type { AttentionKind } from "../src/shared/types.ts";
import { createAttentionBatcher, notifyAttention } from "../src/web/sound.ts";

function fakeTimer() {
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const fire = () => {
    const t = timers.shift();
    if (!t) throw new Error("no timer pending");
    t.fn();
  };
  return { timers, setTimer, fire };
}

test("sound batcher: burst plays one sound with the most urgent kind", () => {
  const played: AttentionKind[] = [];
  const t = fakeTimer();
  const b = createAttentionBatcher((k) => played.push(k), 1000, t.setTimer);
  b.push("inert");
  b.push("error");
  b.push("question");
  expect(t.timers.length).toBe(1);
  expect(t.timers[0]!.ms).toBe(1000);
  t.fire();
  expect(played).toEqual(["error"]);

  b.push("inert");
  expect(t.timers.length).toBe(1);
  t.fire();
  expect(played).toEqual(["error", "inert"]);
});

test("sound batcher: nothing plays before the timer fires", () => {
  const played: AttentionKind[] = [];
  const t = fakeTimer();
  const b = createAttentionBatcher((k) => played.push(k), 1000, t.setTimer);
  b.push("question");
  b.push("inert");
  expect(played).toEqual([]);
  t.fire();
  expect(played).toEqual(["question"]);
  expect(t.timers.length).toBe(0);
});

test("sound batcher: lower priority does not downgrade pending kind", () => {
  const played: AttentionKind[] = [];
  const t = fakeTimer();
  const b = createAttentionBatcher((k) => played.push(k), 1000, t.setTimer);
  b.push("error");
  b.push("inert");
  b.push("question");
  t.fire();
  expect(played).toEqual(["error"]);
});

test("notifyAttention drops events before audio is unlocked", () => {
  expect(() => notifyAttention("error")).not.toThrow();
});
