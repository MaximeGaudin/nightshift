---
name: nightshift-grill
description: Grills a Nightshift kanban card before specification. Reads the note, asks every blocking product question in one questions list, folds the answers into the note, and moves the card on only when it is ready to specify. Use when a Nightshift skill column reviews a card before the specification phase.
---

# Nightshift Grill

This skill is used in Nightshift to review a kanban note and ask all the questions that need to be asked before the specification phase.

The note is the card description. This skill stops when that note is ready to specify. Writing specs is a different skill. Do not write them here.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`) and the board columns.
- The working directory is the board project.
- Project context files are optional. Happy path, when present: `README.md`, `docs/Stack.md`, and the brief under `docs/01 - Briefs/` that the note cites by path or name. When the note cites none, do not read that folder. If a path is missing, skip it and continue from the note. Do not ask for a different tree.

## Steps

1. Read the card title and description in the worker prompt. That text is the note under review.
   - If the prompt has no card: set `move` to `stay`, put one question asking for the note, and stop.
2. Read the optional project context from Prerequisites so a later question does not ask something already decided.
   - When the note names an existing screen, command, or module, read that code.
   - On a missing file: skip it and continue from the note alone.
3. List every blocking gap against the readiness bar. A gap is blocking when a specification agent would have to invent a product decision to build this card.
4. Decide every non-blocking choice yourself and write it into the note. Do not ask about file layout, library choice, or internal names.
5. If any blocking gap remains, ask every gap (see Asking questions) and stop.
6. On the next run, read and fold the answers as the prompt's question rule says, then repeat from step 3. Ask again only when an answer opens a new blocking gap, all new gaps at once.
7. When no blocking gap remains, make sure the note ends with `## Acceptance`: checkable criteria, each one observable in a test or on a screen. Write them from the note when they are missing; they are what implement and review check against.
8. Route the card (see Route), return `questions` as an empty array, and stop. Do not write spec files and do not edit application code.

## Asking questions

The prompt fixes the question format. What to ask:

- Skip a question the note or the project files already answer.
- Skip a question whose only honest answer is "whatever you think". Decide it, write it into the note, and move on.
- When the note is empty or a single vague sentence, ask only the questions that establish what the card covers. Ask that set all at once. Do not invent a questionnaire for a product the note does not describe.

## Readiness bar

The note is ready to specify when an agent could build this card without inventing a product decision:

- **Nouns are defined.** Every domain concept the note names is defined once, with its fields and how it relates to the others.
- **Behaviour is stated.** Each capability says who does it, what they see, and what happens on the unhappy path.
- **Boundaries are explicit.** The note says what is out of scope or deferred.
- **Claims are testable.** Words such as elegant, simple, fast, or accessible name something observable.
- **No dangling references.** Anything mentioned in passing is specified in the note or parked under `## Open questions`.
- **Acceptance is checkable.** `## Acceptance` lists criteria a test or a screen can show.

## Route

Most cards do not need a written plan: the implement agent plans small work itself. Send the card past `nightshift-plan` unless one of these holds:

- it changes two or more modules that must agree on a new contract (an API and its consumer, a schema and its UI, a protocol and both ends);
- it touches persistent or shared state: a data migration, a storage format, state shared across processes or replicas;
- it involves concurrency or async ordering, security, authentication or secrets;
- it removes or replaces a feature other code uses;
- it is large: more than about five files of new logic, or other cards of a series depend on its design;
- the note asks for a plan.

When one holds, set `move` to `next` (the plan column). Otherwise set `move` to the id of the column whose skill is `nightshift-implement`, read from the board columns in the worker prompt; when no such column exists, use `next`. When the card skips the plan, also return `models`, using the rules of `## Choosing models` in `nightshift-plan`: `nightshift-implement` is `haiku` when everything is mechanical and fully specified, `sonnet` otherwise (never `opus`: a card that needs it holds a rule above and goes to the plan); `nightshift-review` and `nightshift-merge` are `sonnet`. When the card goes to the plan, return no `models`. Write the decision as the last line before `## Acceptance`: `Route: plan — <the rule that holds>` or `Route: implement — no plan needed (<one clause>)`.

## Writing the note

A note that needs restructuring as a whole (an empty or one-line note, headings moved around) is the case for `description`.

- Keep the user's sentences verbatim. Add and restructure around them.
- Fold each decision into prose, a list, or a table under the heading it belongs to.
- Record the decision, not the deliberation. Do not append a Q&A log.
- Park anything the user defers under `## Open questions`. Remove a bullet once it is answered.
- Add a heading when decisions have no home.
- On a question round, the only questions in the note are the `## Questions` section.

## Output

Ready, small enough to skip the plan (`move` is the implement column's id; a card that needs the plan uses `next` and no `models`):

```json
{
  "title": "current title",
  "sections": [{"heading": "Acceptance", "content": "…"}],
  "move": "col_implement_id",
  "models": {"nightshift-implement": "sonnet", "nightshift-review": "sonnet", "nightshift-merge": "sonnet"},
  "summary": "Note is ready. No plan needed: one module, existing pattern. Sent to Implement.",
  "questions": []
}
```

## Done when

- [ ] The ready note ends with `## Acceptance` and a `Route:` line, and `move` follows Route
- [ ] Every blocking gap is in the current `questions` list, or the list is empty because the note clears the readiness bar
- [ ] After answers, the note contains the decisions and no longer contains `## Questions`
- [ ] No spec file and no application code was written
