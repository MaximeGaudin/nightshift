import { expect, test } from "bun:test";
import { buildFeedbackPrompt, buildPrompt, DESCRIPTION_CHANGED, DESCRIPTION_UNCHANGED } from "../src/server/orchestrator.ts";
import { defaultBoard } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";

const col: Column = { id: "c", name: "Work", type: "skill", skill: "enrich" };
const board = { ...defaultBoard("x"), columns: [col] };
const long = (tag: string) => `${tag} `.repeat(40).trim();
const desc = `Intro line\n\n## Brief\n\n${long("brief")}\n\n## Tasks\n\n${long("tasks")}\n\n## Tests\n\n${long("tests")}\n`;
const cardOf = (description: string) =>
  ({ id: "k", number: 1, title: "t", description, pendingAnswer: { kind: "feedback", text: "fb" } }) as unknown as Card;
const prompts = (description: string, seen?: string) => [
  buildPrompt(board, cardOf(description), col, undefined, {}, seen),
  buildFeedbackPrompt(board, cardOf(description), col, "enrich", undefined, {}, seen),
];

test("prompt-full-without-seen: without a snapshot both prompts carry the whole description, as before", () => {
  const c = cardOf(desc);
  expect(buildPrompt(board, c, col, undefined, {}, undefined)).toBe(buildPrompt(board, c, col, undefined));
  for (const p of prompts(desc)) {
    expect(p).toContain(`<description>\n${desc}\n</description>`);
    expect(p).not.toContain(DESCRIPTION_UNCHANGED);
  }
});

test("prompt-unchanged: a snapshot equal to the description replaces its body with one sentence", () => {
  for (const p of prompts(desc, desc)) {
    expect(p).toContain(`<description unchanged="true">\n${DESCRIPTION_UNCHANGED}\n</description>`);
    expect(p).not.toContain(long("brief"));
    expect(p).not.toContain("## Tasks");
    expect(p).toContain("<title>t</title>");
  }
});

test("prompt-one-section-changed: only the changed section is sent, with the deleted titles", () => {
  const edited = desc.replace(long("tasks"), "new tasks");
  for (const p of prompts(edited, desc)) {
    expect(p).toContain(`<description-changes>\n${DESCRIPTION_CHANGED}\n\n## Tasks\n\nnew tasks\n</description-changes>`);
    expect(p).not.toContain(long("brief"));
    expect(p).not.toContain("## Tests");
  }
  const deleted = desc.replace(`## Tests\n\n${long("tests")}\n`, "");
  for (const p of prompts(deleted, desc)) {
    expect(p).toContain(`<description-changes>\n${DESCRIPTION_CHANGED}\n\nDeleted sections: Tests\n</description-changes>`);
    expect(p).not.toContain(long("brief"));
  }
  const added = `${desc}\n## Result\n\ndone\n`;
  for (const p of prompts(added, desc)) expect(p).toContain(`${DESCRIPTION_CHANGED}\n\n## Result\n\ndone\n</description-changes>`);
  const preamble = desc.replace("Intro line", "Intro edited");
  for (const p of prompts(preamble, desc))
    expect(p).toContain(`${DESCRIPTION_CHANGED}\n\nText before the first section:\nIntro edited\n</description-changes>`);
  const noPreamble = desc.replace("Intro line\n\n", "");
  for (const p of prompts(noPreamble, desc))
    expect(p).toContain(`${DESCRIPTION_CHANGED}\n\nText before the first section: removed.\n</description-changes>`);
});

test("prompt-fallback-duplicate: duplicate headings or a diff no shorter than the note send the whole description", () => {
  const dup = `${desc}\n## Brief\n\nagain\n`;
  for (const p of prompts(dup, desc)) expect(p).toContain(`<description>\n${dup}\n</description>`);
  for (const p of prompts(desc, dup)) expect(p).toContain(`<description>\n${desc}\n</description>`);
  // Everything changed: the changes block would be longer than the note itself.
  const small = "## A\n\nx\n";
  for (const p of prompts(small, "## B\n\ny\n")) expect(p).toContain(`<description>\n${small}\n</description>`);
});
