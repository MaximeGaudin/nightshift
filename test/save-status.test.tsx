import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type SaveState, SaveStatus, trackSave } from "../src/web/SaveStatus.tsx";

function run(result: boolean) {
  const states: SaveState[] = [];
  const resets: Array<() => void> = [];
  const done = trackSave(
    async () => result,
    (s) => states.push(s),
    (r) => resets.push(r),
  );
  return { states, resets, done };
}

test("a successful save goes saving, saved, then idle once the delay ends", async () => {
  const { states, resets, done } = run(true);
  expect(await done).toBe(true);
  expect(states).toEqual(["saving", "saved"]);
  resets[0]?.();
  expect(states).toEqual(["saving", "saved", "idle"]);
});

test("a failed save never shows saved", async () => {
  const { states, resets, done } = run(false);
  expect(await done).toBe(false);
  expect(states).toEqual(["saving", "idle"]);
  expect(resets).toHaveLength(0);
});

test("the indicator is a polite status region, empty when idle", () => {
  const idle = renderToStaticMarkup(<SaveStatus state="idle" />);
  expect(idle).toContain('role="status"');
  expect(idle).toContain('aria-live="polite"');
  expect(idle).not.toContain("Enregistré");
});

test("the indicator shows the saving and saved labels", () => {
  expect(renderToStaticMarkup(<SaveStatus state="saving" />)).toMatch(/Enregistrement…|Saving…/);
  expect(renderToStaticMarkup(<SaveStatus state="saved" />)).toMatch(/Enregistré|Saved/);
});
