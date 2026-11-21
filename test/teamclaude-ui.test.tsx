import { afterEach, expect, mock, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamclaudeAction, TeamclaudeWait } from "../src/shared/types.ts";
import type { QuotaSnapshot } from "../src/shared/usage.ts";
import { setLocale } from "../src/web/i18n/index.ts";
import { QuotaIndicatorView, quotaTooltipLines } from "../src/web/QuotaIndicator.tsx";

// Radix dialogs render nothing on the server: swap them for plain wrappers so the dialog body is rendered.
const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module(new URL("../src/web/components/ui/dialog.tsx", import.meta.url).pathname, () => ({
  Dialog: Passthrough,
  DialogTrigger: Passthrough,
  DialogPortal: Passthrough,
  DialogClose: Passthrough,
  DialogOverlay: Passthrough,
  DialogContent: Passthrough,
  DialogHeader: Passthrough,
  DialogFooter: Passthrough,
  DialogTitle: Passthrough,
  DialogDescription: Passthrough,
}));
const { TeamclaudeWaitView, teamclaudeFailureText } = await import("../src/web/TeamclaudeWaitDialog.tsx");

afterEach(() => setLocale("fr"));

const WAIT: TeamclaudeWait = {
  failure: { kind: "no-response", url: "http://localhost:3456" },
  entries: [
    { project: "/work/alpha", cardId: "c1", ref: "#12", title: "Fix login" },
    { project: "/work/beta", quickRunId: "qr1", title: "enrich" },
  ],
  retrying: false,
};
const view = (wait: TeamclaudeWait, busy = false, onDecide: (a: TeamclaudeAction) => void = () => {}) =>
  TeamclaudeWaitView({ wait, busy, onDecide, onClose: () => {} });

/** The footer buttons of the dialog element, in order. */
const buttons = (el: ReactElement): ReactElement<{ disabled: boolean; onClick: () => void }>[] => {
  const footer = (el.props as { footer: ReactElement<{ children: ReactNode }> }).footer;
  return ([] as ReactNode[]).concat(footer.props.children).filter(isValidElement) as ReactElement<{
    disabled: boolean;
    onClick: () => void;
  }>[];
};

test("teamclaude-dialog-ui: reason with the URL, the waiting runs and three choices", () => {
  // Title and reason are props of the dialog shell: another test file may mock its header differently in a full run.
  const el = view(WAIT);
  expect((el.props as { title: string }).title).toBe("Proxy teamclaude injoignable");
  expect((el.props as { description: string }).description).toBe("Aucune réponse de http://localhost:3456.");
  const html = renderToStaticMarkup(el);
  expect(html).toContain("#12");
  expect(html).toContain("Fix login");
  expect(html).toContain("— alpha");
  expect(html).toContain("enrich");
  for (const label of ["Réessayer", "Lancer sans teamclaude", "Annuler les runs"]) expect(html).toContain(label);
  setLocale("en");
  expect(renderToStaticMarkup(view(WAIT))).toContain("Run without teamclaude");
});

test("teamclaude-dialog-ui: every reason is translated", () => {
  expect(teamclaudeFailureText({ kind: "not-found" })).toBe("teamclaude introuvable dans le PATH.");
  expect(teamclaudeFailureText({ kind: "env-failed", detail: "boom" })).toBe("teamclaude env a échoué : boom");
});

test("teamclaude-dialog-ui: buttons are disabled while retrying or busy, and send the choice", () => {
  expect(buttons(view({ ...WAIT, retrying: true })).every((b) => b.props.disabled)).toBe(true);
  expect(buttons(view(WAIT, true)).every((b) => b.props.disabled)).toBe(true);
  const sent: TeamclaudeAction[] = [];
  const bs = buttons(view(WAIT, false, (a) => sent.push(a)));
  expect(bs.every((b) => !b.props.disabled)).toBe(true);
  for (const b of bs) b.props.onClick();
  expect(sent).toEqual(["cancel", "direct", "retry"]);
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const pooled = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  fiveHour: { utilization: 0.4, resetsAt: NOW / 1000 + 3600 },
  sevenDay: { utilization: 0.7, resetsAt: NOW / 1000 + 86400 },
  at: new Date(NOW - 30000).toISOString(),
  source: "teamclaude",
  accounts: 3,
  ...over,
});

test("teamclaude-quota-tooltip: the pool and its account count, dimmed when unreachable", () => {
  const lines = quotaTooltipLines(pooled(), NOW, "fr");
  expect(lines).toContain("Groupe teamclaude · 3 comptes");
  expect(lines.some((l) => l.includes("injoignable"))).toBe(false);
  expect(renderToStaticMarkup(<QuotaIndicatorView usage={pooled()} now={NOW} />)).not.toContain("opacity-60");
  const down = pooled({ unreachable: true });
  expect(quotaTooltipLines(down, NOW, "fr")).toContain("Proxy teamclaude injoignable : dernières valeurs lues");
  expect(renderToStaticMarkup(<QuotaIndicatorView usage={down} now={NOW} />)).toContain("opacity-60");
});
