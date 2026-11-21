---
name: nightshift-plan
description: Writes a Nightshift implementation plan from a grilled kanban note. Specifies architecture, an ordered list of tasks with the code context they need, numbered progress steps, tests, the definition of done and the card's models, and leaves routine coding to the implement agent. Use when a Nightshift skill column turns a grilled card into a specification.
---

# Nightshift Plan

Take a grilled brief and write the implementation specification. The specification holds the architecture and the hard decisions. Leave routine implementation to the implement agent.

The specification is the card description. Do not create `docs/02 - Specs/`. Do not write application code.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`) and the board columns. The description is the grilled brief.
- The working directory is the board project.
- Project context files are optional. Happy path, when present: `README.md`, `docs/Stack.md`, and the code the brief names. If a path is missing, skip it and continue from the brief. Do not ask for a different tree. What grill read earlier in this session is still known: do not read it again.

## Steps

1. Read the card title and description. That description is the grilled brief.
   - If the prompt has no card: set `move` to `stay`, put one question asking for the brief, and stop.
2. Read the optional project context from Prerequisites so the plan matches the stack and the code that already exists.
   - On a missing file: skip it and continue from the brief.
3. If the brief still needs a product decision (an undefined noun, a behavior with no unhappy path, a missing boundary, or an untestable claim), do not plan. Ask every gap at once, in the prompt's question format, and stop. Ask questions only in this step, and phrase each so the answer changes the product.
4. On the next run, fold the answers into the brief as the prompt's question rule says. Repeat from step 3.
5. Write the specification into the description, using the template below, as `sections`: add `## Progress`, `## Architecture`, `## Tasks`, `## Tests`, `## Definition of done` and `## Models`. The grilled note stays as it is: do not return it. Sections are added at the end of the note, after the grilled note.
6. Set `move` to `next` and return `questions` as an empty array. Stop.

## What the specification decides

Write these. A competent implement agent must not have to invent them:

- Module boundaries, the data model, and the invariants that must hold.
- State transitions, failure behavior, and the contracts between tasks.
- The order of the tasks, and for each one the files it lands in and the `file:line` context it needs, so the implement agent does not have to search the repository.
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
## Progress

- [ ] 1. Shared contract
- [ ] 2. <task name>

## Architecture

The hard design: boundaries, data model, invariants, failure behavior.
Name each module by its responsibility. State the contract other tasks will import.

## Tasks

### Task 1 — Shared contract
Files: the modules that define the contract.
Context: `path/to/module.py:120-180` (what is there and what changes), the commands to run, the existing pattern to copy.
Hard part: the invariant or transition that is easy to get wrong.
Done when: the contract is in the tree and the tests below that cover it pass.

### Task 2 — <name>
Files: <modules or paths>.
Context: <`file:line` references and facts this task needs>.
Hard part: <the non-obvious behavior>.
Done when: <observable outcome>.

## Tests

- `<name>`: given <state>, when <action>, then <observable result>. Covers Task <n>.

## Definition of done

- [ ] <What a user can do, or what a command prints, when this card is finished>
- [ ] Every test in Tests passes
```

Rules for Tasks:

- One implement session does the tasks one after the other, in the order written: there are no waves and no parallel tasks. Order them so each task builds on the previous ones; put a shared contract first.
- `Files` says where a task lands: a guide for the implementer and the reviewer, not an ownership rule.
- `Context` carries the research, so the implement agent reads only what it touches: the `file:line` ranges, the existing pattern to follow, the command that runs the relevant tests. Copy facts you verified in the code, not guesses.
- One task, one hard part. Split a task that contains two unrelated hard parts; merge tasks that are too small to be worth a checkbox.

## Progress list

`## Progress` shows a person how far implementation got: one unchecked line per task, `- [ ] N. <task name>`, numbered from 1 with no gaps, in task order, and no line that is not a task. Never renumber a written step. The implement agent checks a line once its task is committed and tested.

Rules for Tests and Definition of done:

- Every test names the task it locks. Skip tests that only repeat a straightforward branch of an already specified behavior.
- Definition of done is observable. Use the project's existing test command when one exists. When none exists, state the outcome without inventing a test runner.
- Every task's "Done when" line is a subset of Definition of done, not a new goal.

## Choosing models

One implement session runs every task on one model, so pick the card's models from its hardest task. A model that is too weak costs a repair loop; one that is too strong costs time and money on every line.

- `haiku`: everything is mechanical and fully specified: renames, text or copy changes, config values, deleting code listed by path, docs.
- `sonnet` (the default): modules, pages or endpoints that follow patterns the project already has, with their tests.
- `opus`: a wrong guess breaks something silently or for good: concurrency or async ordering, state shared across processes or replicas, security, authentication or secrets, a data migration or an irreversible operation, a refactor across modules, or a `Hard part` whose invariant is easy to break.

Add them at the end of the specification:

```markdown
## Models

- nightshift-implement: <haiku | sonnet | opus, from the hardest task>
- nightshift-review: <sonnet, or opus when implement is opus>
- nightshift-merge: sonnet
```

Also return the same values in the structured output's `models` field, keyed by skill name: Nightshift runs the card's next columns on them, unless a column locks its own model.

## Output

Plan ready (`questions` empty, `move` is `next`):

```json
{
  "title": "current or tightened title",
  "sections": [{"heading": "Progress", "content": "…"}, {"heading": "Architecture", "content": "…"}, {"heading": "Tasks", "content": "…"}, {"heading": "Tests", "content": "…"}, {"heading": "Definition of done", "content": "…"}, {"heading": "Models", "content": "…"}],
  "models": {"nightshift-implement": "sonnet", "nightshift-review": "sonnet", "nightshift-merge": "sonnet"},
  "move": "next",
  "summary": "Plan ready: 3 tasks, implement on sonnet.",
  "questions": []
}
```

## Done when

- [ ] The note gains every section of the template plus `## Models`, and the `models` output matches it
- [ ] Every task has `Files`, `Context` with `file:line` references, `Hard part` and `Done when`
- [ ] No function bodies or routine implementation steps
- [ ] `move` is `next` with empty `questions`, or `stay` because product questions are open
