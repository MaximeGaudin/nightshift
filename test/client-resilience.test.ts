import { expect, test } from "bun:test";
import { parseServerEvent, reconnectDelay } from "../src/web/api.ts";
import { attempt, deleteThenClose, sendThenClear } from "../src/web/cardActions.ts";

test("client-reconnect: the delay backs off and is capped", () => {
  expect([1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000]);
  expect(reconnectDelay(6)).toBe(30_000);
  expect(reconnectDelay(100)).toBe(30_000);
  expect(reconnectDelay(0)).toBe(1000);
});

test("client-parse: malformed WebSocket messages are dropped, not thrown", () => {
  expect(parseServerEvent("{oops")).toBeNull();
  expect(parseServerEvent("42")).toBeNull();
  expect(parseServerEvent("null")).toBeNull();
  expect(parseServerEvent('{"nope":1}')).toBeNull();
  expect(parseServerEvent(new ArrayBuffer(2))).toBeNull();
  expect(parseServerEvent('{"type":"settings","settings":{}}')).toMatchObject({ type: "settings" });
});

test("card-modal-failed-action: attempt reports the error and gives false", async () => {
  const errors: string[] = [];
  expect(await attempt(Promise.resolve(1), (m) => errors.push(m))).toBe(true);
  expect(await attempt(Promise.reject(new Error("boom")), (m) => errors.push(m))).toBe(false);
  expect(errors).toEqual(["boom"]);
});

test("card-modal-failed-action: a failed delete keeps the card open, a failed answer keeps the form", async () => {
  const errors: string[] = [];
  const log = (m: string) => errors.push(m);
  let closed = 0;
  let cleared = 0;
  await deleteThenClose(Promise.reject(new Error("delete failed")), () => closed++, log);
  await sendThenClear(Promise.reject(new Error("answer failed")), () => cleared++, log);
  expect({ closed, cleared, errors }).toEqual({ closed: 0, cleared: 0, errors: ["delete failed", "answer failed"] });

  await deleteThenClose(Promise.resolve(), () => closed++, log);
  await sendThenClear(Promise.resolve(), () => cleared++, log);
  expect({ closed, cleared }).toEqual({ closed: 1, cleared: 1 });
});
