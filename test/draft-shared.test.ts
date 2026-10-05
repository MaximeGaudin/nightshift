import { expect, test } from "bun:test";
import { isHeld, isReady } from "../src/shared/dependencies.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, DONE_COLUMN_ID } from "../src/shared/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  number: 1,
  title: id,
  description: "",
  columnId: BACKLOG_COLUMN_ID,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...over,
});

test("draft: isReady is false for a draft whose dependencies are done, isHeld stays true", () => {
  const dep = card("d", { columnId: DONE_COLUMN_ID });
  const b: Pick<Board, "cards"> = { cards: [dep] };
  const draft = card("x", { dependsOn: ["d"], draft: true });
  const plain = card("y", { dependsOn: ["d"] });
  expect(isHeld(draft)).toBe(true);
  expect(isReady(b, draft)).toBe(false);
  expect(isReady(b, plain)).toBe(true);
});
