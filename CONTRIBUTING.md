# Contributing to Nightshift

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Questions and bugs go to GitHub Issues.

## Setup

Prerequisites: [Bun](https://bun.sh) >= 1.4.2, git, and the Claude Code CLI (only needed to run real agents; tests use `test/fake-claude.ts`).

```sh
git clone https://github.com/MaximeGaudin/nightshift.git nightshift && cd nightshift
bun install
bun start <project>      # run against a project folder
```

## Before opening a pull request

Run the full check. It runs Biome, the TypeScript compiler and the tests, and CI runs the same command on Linux and macOS:

```sh
bun run check
```

Use `bun run format` to fix formatting. Keep pull requests focused, and add or update tests for behavior changes.

## Commit style

Use a conventional prefix and a short imperative summary:

- `feat: add a language setting`
- `fix: keep the card selected after a drag`

Other prefixes in use: `chore:`, `docs:`, `test:`.

## Adding a UI string

The web UI is available in English and French. Every user-visible string (labels, buttons, tooltips, toasts, aria-labels, empty states) goes through the in-house i18n layer in `src/web/i18n`:

1. Add the key to `src/web/i18n/en/<ns>.ts` and the French text to `src/web/i18n/fr/<ns>.ts`. Keys are flat, `"<ns>.<name>"`, and the English file defines the allowed keys. For plurals add `<key>_one` and `<key>_other`.
2. In a component, call `const { t } = useT()` and use `t("<ns>.<name>", { param })`. Outside components, import `t` directly.
3. Never compute translated text at module top level (for example in a constant array of commands). Store keys there and call `t()` at render time, so the text follows the active language.
4. The parity test checks that `en` and `fr` have exactly the same keys; `bun test` fails if one side is missing.

Server messages, agent prompts and skills stay in English.

## Template skills

The skills in `skills/` are copied into new projects. Changes to them affect only projects created afterwards.
