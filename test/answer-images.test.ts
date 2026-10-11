import { expect, test } from "bun:test";
import { canAnswer } from "../src/web/CardModal.tsx";

test("answers-uploading-disables-resume", () => {
  expect(canAnswer(["", "see image"], 1)).toBe(false);
  expect(canAnswer(["", "see image"], 0)).toBe(true);
  expect(canAnswer(["", " "], 0)).toBe(false);
  expect(canAnswer([], 0)).toBe(false);
});
