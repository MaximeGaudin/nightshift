---
name: nightshift-grill
description: Grills a Nightshift kanban card before specification. Reads the note, asks every blocking product question in one questions list, folds the answers into the note, and moves the card on only when it is ready to specify. Use when a Nightshift skill column reviews a card before the specification phase.
---

# Nightshift Grill

This skill is used in Nightshift to review a kanban note and ask all the questions that need to be asked before the specification phase. Make sure to ask all your questions at once.

The note is the card description. This skill stops when that note is ready to specify. Writing specs is a different skill. Do not write them here.

## Prerequisites

- The Nightshift worker prompt contains the card (`<title>`, `<description>`) and the board columns.
- Return work only as Nightshift's structured result (`title`, `description`, `move`, `summary`, `questions`). Nightshift updates the board from that result.
- Do not call `AskUserQuestion`. Do not edit `nightshift.json`.
- The working directory is the board project.
- Project context files are optional. Happy path, when present: `README.md`, `docs/Stack.md`, and `docs/01 - Briefs/`. If a path is missing, skip it and continue from the note. Do not ask for a different tree.

## Steps

Progress marker: at the start of each step, write `[nightshift-progress] N/M label` alone on its own line, where N is the current step number, M is the total number of steps, and label is a few words naming the step. Use the numbering of this `## Steps` list. A machine reads this line, so it overrides any concise or no-narration style.

1. Read the card title and description in the worker prompt. That text is the note under review.
   - If the prompt has no card: set `move` to `stay`, put one question asking for the note, and stop.
2. Read the optional project context from Prerequisites so a later question does not ask something already decided.
   - When the note names an existing screen, command, or module, read that code.
   - On a missing file: skip it and continue from the note alone.
3. List every blocking gap against the readiness bar. A gap is blocking when a specification agent would have to invent a product decision to build this card.
4. Decide every non-blocking choice yourself and write it into the note. Do not ask about file layout, library choice, or internal names.
5. If any blocking gap remains, write every gap into the note under `## Questions` (see Questions), return the same list in `questions`, and set `move` to `stay`. Stop. Do not hold questions back for a later round.
6. On the next run, read each answer from the note first: the text under that question, down to the next numbered question. Ignore blank lines. When that text is empty and the resume prompt has an answer for the same question, use the resume answer.
   - When both are empty, decide it yourself. Do not ask that question again.
   - Fold the answers into the note, delete `## Questions`, then repeat from step 3.
   - Ask again only when an answer opens a new blocking gap. Put every new gap in that next list, all at once, each with blank lines under it.
7. When no blocking gap remains, set `move` to `next` and return `questions` as an empty array. Stop. Do not write spec files and do not edit application code.

Follow extra column instructions in the worker prompt when they do not contradict the steps above.

## Questions

Ask in two places, with the same questions in the same order:

- `questions`: one decision per string, a single line. Nightshift shows these beside the card.
- The note: a `## Questions` section at the end. The user answers there, in the markdown.

Phrase each question so the answer changes what gets built. Put the real options in the question. End with `Recommended: <option> — <one-line consequence>.` Write questions in the language of the note.

Under each question in the note, leave exactly three blank lines. Do not put a placeholder, a label, or a rule in those lines. That empty space is where the user types the answer.

```markdown
## Questions

1. Who can archive a card: only the author, or anyone who can open the board? Recommended: only the author — avoids silent data loss.



2. When a run fails, does the card stay in this column, or move to a failed column? Recommended: stay — the board already shows the error on the card.



```

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

## Writing the note

Return the full description. Nightshift replaces the card description with that string.

- Keep the user's sentences verbatim. Add and restructure around them.
- Fold each decision into prose, a list, or a table under the heading it belongs to.
- Record the decision, not the deliberation. Do not append a Q&A log.
- Park anything the user defers under `## Open questions`. Remove a bullet once it is answered.
- Add a heading when decisions have no home.
- On a question round, the only questions in the note are the `## Questions` section, each followed by three blank lines. After the answers are folded in, delete that section.

## Output

Question round (`move` is `stay` whenever `questions` is non-empty):

```json
{
  "title": "current or tightened title",
  "description": "full markdown note, plus ## Questions with three blank lines under each question",
  "move": "stay",
  "summary": "Asked 4 blocking questions before specification.",
  "questions": [
    "Who can archive a card: only the author, or anyone who can open the board? Recommended: only the author — avoids silent data loss.",
    "When a run fails, does the card stay in this column, or move to a failed column? Recommended: stay — the board already shows the error on the card."
  ]
}
```

Ready (`questions` empty, `move` is `next`):

```json
{
  "title": "current title",
  "description": "full markdown note",
  "move": "next",
  "summary": "Note is ready for specification. No blocking product decisions left.",
  "questions": []
}
```

## Done when

- [ ] Every blocking gap is in the current `questions` list, or the list is empty because the note clears the readiness bar
- [ ] `move` is `stay` when `questions` is non-empty, and `next` only when the bar is clear
- [ ] On a question round, `## Questions` ends the note and each question has three blank lines under it
- [ ] After answers, the note contains the decisions and no longer contains `## Questions`
- [ ] No spec file and no application code was written
