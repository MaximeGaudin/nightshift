---
name: nightshift-plan
description: Writes a Nightshift implementation plan from a grilled kanban note. Specifies architecture, parallel tasks, numbered progress steps, tests, and the definition of done, and leaves routine coding to the implement agent. Use when a Nightshift skill column turns a grilled card into a specification.
---

# Nightshift Plan

Take a grilled brief and write the implementation specification. The specification holds the architecture and the hard decisions. Leave routine implementation to the implement agent.

The specification is the card description. Do not create `docs/02 - Specs/`. Do not write application code.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`) and the board columns. The description is the grilled brief.
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`). Nightshift updates the board from that result.
- Do not call `AskUserQuestion`. Do not edit `nightshift.json`.
- The working directory is the board project.
- Project context files are optional. Happy path, when present: `README.md`, `docs/Stack.md`, and the code the brief names. If a path is missing, skip it and continue from the brief. Do not ask for a different tree.

## Steps

Progress marker: at the start of each step, write `[nightshift-progress] N/M label` alone on its own line, where N is the current step number, M is the total number of steps, and label is a few words naming the step. Use the numbering of this `## Steps` list. A machine reads this line, so it overrides any concise or no-narration style.

1. Read the card title and description. That description is the grilled brief.
   - If the prompt has no card: set `move` to `stay`, put one question asking for the brief, and stop.
2. Read the optional project context from Prerequisites so the plan matches the stack and the code that already exists.
   - On a missing file: skip it and continue from the brief.
3. If the brief still needs a product decision (an undefined noun, a behavior with no unhappy path, a missing boundary, or an untestable claim), do not plan. Ask every gap at once, set `move` to `stay`, and stop. See Questions.
4. On the next run, read answers the same way as Questions. Fold them into the brief. Delete `## Questions`. Repeat from step 3.
5. Write the specification into the description, using the template below. Keep the user's product sentences verbatim under `## Brief`.
6. Set `move` to `next` and return `questions` as an empty array. Stop.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## What the specification decides

Write these. A competent implement agent must not have to invent them:

- Module boundaries, the data model, and the invariants that must hold.
- State transitions, failure behavior, and the contracts between tasks.
- Which tasks run in parallel, which wait, and which files or modules each task owns.
- The important tests and the definition of done.

Write the decision and the constraint. Do not write function bodies, import lists, or boilerplate.

## What the implement agent decides

Leave these out of the specification:

- Routine code once a contract above already fixes the behavior.
- Formatting, local names, and obvious wiring that follows an existing pattern in the project.
- A test for every helper. Name only the tests that fail when the architecture or the definition of done is wrong.

Do not fill a gap with "the implement agent chooses" when the choice is hard. Decide it and write it down.

## Specification

Section headings stay in English. Prose matches the language of the brief.

```markdown
## Brief

The grilled brief, user sentences kept.

## Progress

- [ ] 1. Wave 0 — Task 0 — Shared contract
- [ ] 2. Wave 1 — Task 1 — <name>
- [ ] 3. Wave 1 — Task 2 — <name>

## Architecture

The hard design: boundaries, data model, invariants, failure behavior.
Name each module by its responsibility. State the contract other tasks will import.

## Tasks

### Wave 0 — sequential

Lock the shared contract. Later tasks import it and do not redesign it.

#### Task 0 — Shared contract
Owns: the modules that define the contract.
Hard part: the invariant or transition that is easy to get wrong.
Done when: the contract is in the tree and the tests below that cover it pass.

### Wave 1 — parallel

Start these together after wave 0. They share no owned files.

#### Task 1 — <name>
Owns: <modules or paths>.
Depends on: Task 0.
Hard part: <the non-obvious behavior>.
Done when: <observable outcome>.

#### Task 2 — <name>
Owns: <modules or paths>.
Depends on: Task 0.
Hard part: <the non-obvious behavior>.
Done when: <observable outcome>.

## Tests

- `<name>`: given <state>, when <action>, then <observable result>. Covers Task <n>.

## Definition of done

- [ ] <What a user can do, or what a command prints, when this card is finished>
- [ ] Every test in Tests passes
- [ ] No task wrote a file owned by another task
```

Rules for Tasks:

- A task may run beside another task only when they do not write the same files and neither needs a type or behavior the other task creates. Put that shared piece in an earlier sequential wave.
- Always include the wave labels. When nothing is parallel, use one sequential wave and write why a split would share files.
- Own paths narrowly. Two parallel tasks never list the same path.
- One task, one hard part. Split a task that contains two unrelated hard parts when the split can run in parallel.

## Progress

`## Progress` is the list a person reads to see how far implementation got. Write it immediately after `## Brief`.

- One checkbox per task. Number from 1 with no gaps, in wave order, then task order inside the wave.
- Line shape: `- [ ] N. Wave W — Task T — <task name>`. Leave every box unchecked.
- Do not renumber a step after it is written. Do not add a progress line that is not a task.
- The implement agent changes `- [ ]` to `- [x]` only after that task is merged. A stopped run leaves later boxes unchecked.

Rules for Tests and Definition of done:

- Every test names the task it locks. Skip tests that only repeat a straightforward branch of an already specified behavior.
- Definition of done is observable. Use the project's existing test command when one exists. When none exists, state the outcome without inventing a test runner.
- Every task's "Done when" line is a subset of Definition of done, not a new goal.

## Questions

Use this only in step 3. Ask in two places, same questions, same order:

- `questions`: one decision per string, a single line.
- The note: a `## Questions` section at the end of the brief. Under each question, leave exactly three blank lines. Do not put a placeholder in those lines.

Phrase each question so the answer changes the product. End with `Recommended: <option> — <one-line consequence>.` Write questions in the language of the brief. Ask every gap in that one list. Do not hold any back.

On the next run, the answer is the text under that question, down to the next numbered question. Ignore blank lines. When that text is empty and the resume prompt has an answer, use the resume answer. When both are empty, decide it yourself and do not ask again.

```markdown
## Questions

1. Who can archive a card: only the author, or anyone who can open the board? Recommended: only the author — avoids silent data loss.



```

## Output

Question round (`move` is `stay` whenever `questions` is non-empty):

```json
{
  "title": "current title",
  "description": "the brief, then ## Questions with three blank lines under each question",
  "move": "stay",
  "summary": "Asked 2 product questions before planning.",
  "questions": [
    "Who can archive a card: only the author, or anyone who can open the board? Recommended: only the author — avoids silent data loss."
  ]
}
```

Plan ready (`questions` empty, `move` is `next`):

```json
{
  "title": "current or tightened title",
  "description": "the specification, from ## Brief through ## Definition of done, with ## Progress still unchecked",
  "move": "next",
  "summary": "Plan ready: 1 sequential wave, then 2 parallel tasks.",
  "questions": []
}
```

## Done when

- [ ] The description contains `## Brief`, `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, and `## Definition of done`
- [ ] `## Progress` has one unchecked numbered line per task, from 1, in wave order
- [ ] Parallel tasks are in a wave marked parallel, with no shared owned path
- [ ] Tests cover the hard behavior, and Definition of done is observable
- [ ] The specification does not contain function bodies or routine implementation steps
- [ ] `move` is `next` and `questions` is empty, or `move` is `stay` because product questions are still open
