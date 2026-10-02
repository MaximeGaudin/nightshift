import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, DONE_COLUMN_ID } from "../src/shared/types.ts";
import { api } from "../src/web/api.ts";
import { DependenciesSection, saveDependencies } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";
import { DependencyPicker, filterDependencyCards } from "../src/web/DependencyPicker.tsx";

const columns: Column[] = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "nightshift-grill" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const T0 = "2026-01-01T00:00:00Z";
const card = (id: string, number: number, over: Partial<Card> = {}): Card => ({
  id,
  number,
  title: `Card ${id}`,
  description: "",
  columnId: BACKLOG_COLUMN_ID,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...over,
});
const d12 = card("d12", 12, { columnId: DONE_COLUMN_ID, title: "Login" });
const d15 = card("d15", 15, { columnId: "col_grill", title: "Signup" });
const x = card("x", 20, { dependsOn: ["d12", "d15"] });
const board: Board = { version: 1, name: "b", columns, cards: [d12, d15, x], nextCardNumber: 21 };

test("createCard sends dependsOn only when non-empty", async () => {
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "x" }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await api.createCard("/p", BACKLOG_COLUMN_ID, "t", "", [], ["d12", "d15"]);
    await api.createCard("/p", BACKLOG_COLUMN_ID, "t", "", [], []);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(bodies[0]?.dependsOn).toEqual(["d12", "d15"]);
  expect(Object.hasOwn(bodies[1] ?? {}, "dependsOn")).toBe(false);
});

test("the picker lists the cards with their column and filters by number or title", () => {
  const html = renderToStaticMarkup(<DependencyPicker cards={[d12, d15]} columns={columns} value={["d15"]} onChange={() => {}} />);
  expect(html).toContain("Dépend de (1)");
  // The selected card comes first.
  expect(html.indexOf("#15")).toBeLessThan(html.indexOf("#12"));
  expect(html).toContain("Grill");
  expect(filterDependencyCards([d12, d15], "#1").map((c) => c.id)).toEqual(["d12", "d15"]);
  expect(filterDependencyCards([d12, d15], "15").map((c) => c.id)).toEqual(["d15"]);
  expect(filterDependencyCards([d12, d15], "sign").map((c) => c.id)).toEqual(["d15"]);
  expect(renderToStaticMarkup(<DependencyPicker cards={[]} columns={columns} value={[]} onChange={() => {}} />)).toBe("");
});

test("the picker hides Done cards unless they are selected", () => {
  const render = (value: string[], cards = [d12, d15]) =>
    renderToStaticMarkup(<DependencyPicker cards={cards} columns={columns} value={value} onChange={() => {}} />);
  const hidden = render([]);
  expect(hidden).toContain("#15");
  expect(hidden).not.toContain("#12");
  expect(hidden).not.toContain("Login");
  // A selected Done card stays, first, and counts in the summary.
  const kept = render(["d12"]);
  expect(kept).toContain("Dépend de (1)");
  expect(kept).toContain("Login");
  expect(kept.indexOf("#12")).toBeLessThan(kept.indexOf("#15"));
  // Nothing proposable and nothing selected: no picker.
  expect(render([], [d12])).toBe("");
});

test("a held card tile shows its unmet dependencies", () => {
  const base = { project: "/p", card: x, onOpen: () => {} };
  expect(renderToStaticMarkup(<CardTile {...base} waitingFor={["#15"]} />)).toContain("attend #15");
  expect(renderToStaticMarkup(<CardTile {...base} waitingFor={[]} />)).toContain("dépendances terminées");
  expect(renderToStaticMarkup(<CardTile {...base} />)).not.toContain("waiting-badge");
});

test("the card detail lists every dependency with its column; the picker only in Backlog", () => {
  const html = renderToStaticMarkup(<DependenciesSection project="/p" card={x} board={board} />);
  expect(html).toContain("Dépendances");
  expect(html).toContain("#12");
  expect(html).toMatch(/text-ok">Done</);
  expect(html).toContain("#15");
  expect(html).toContain("Signup");
  expect(html).toContain('aria-label="Ouvrir #15"');
  expect(html).toContain("dependency-picker");

  const moved = { ...x, columnId: "col_grill" };
  const out = renderToStaticMarkup(<DependenciesSection project="/p" card={moved} board={board} />);
  expect(out).toContain("#12");
  expect(out).not.toContain("dependency-picker");
  expect(out).toContain("Modifiables seulement dans Backlog");

  const plain = card("p", 30, { columnId: "col_grill" });
  expect(renderToStaticMarkup(<DependenciesSection project="/p" card={plain} board={board} />)).toBe("");
});

test("saveDependencies reports a refused change", async () => {
  const errors: string[] = [];
  const ok = await saveDependencies({
    project: "/p",
    cardId: "x",
    ids: ["d15"],
    onError: (m) => errors.push(m),
    update: async () => {
      throw new Error("Dependency cycle: #15 → #20 → #15");
    },
  });
  expect(ok).toBe(false);
  expect(errors).toEqual(["Dependency cycle: #15 → #20 → #15"]);
  const sent: unknown[] = [];
  expect(
    await saveDependencies({ project: "/p", cardId: "x", ids: [], onError: () => {}, update: async (_p, _i, patch) => sent.push(patch) }),
  ).toBe(true);
  expect(sent).toEqual([{ dependsOn: [] }]);
});
