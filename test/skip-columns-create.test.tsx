import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, Column } from "../src/shared/types.ts";
import { AddCard, skipOptions, submitAddCard } from "../src/web/AddCard.tsx";
import { api } from "../src/web/api.ts";
import { CardTile } from "../src/web/CardTile.tsx";

const col = (id: string, name: string): Column => ({ id, name }) as Column;
const columns = [
  col("col_fdc888c3ed", "Backlog"),
  col("col_49f412ad26", "Grill"),
  col("col_fd6f5dbde7", "Plan"),
  col("col_dae4813644", "Implement"),
  col("col_0fc8f00a6b", "Review"),
  col("col_2e5738f5a3", "To Test"),
  col("col_f95bc1734d", "Merge"),
  col("col_done", "Done"),
];
const TO_TEST = "col_2e5738f5a3";

test("form in Backlog is collapsed and offers Grill..Merge without Done", () => {
  const options = skipOptions(columns, "col_fdc888c3ed");
  expect(options.map((c) => c.name)).toEqual(["Grill", "Plan", "Implement", "Review", "To Test", "Merge"]);
  const html = renderToStaticMarkup(<AddCard initialOpen skipOptions={options} onAdd={() => {}} />);
  expect(html).toContain("skip-picker");
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).toContain("Sauter des colonnes");
  expect(html).not.toContain("Done");
  expect(html).not.toContain("checked");
});

test("no section in Merge (only Done follows)", () => {
  const options = skipOptions(columns, "col_f95bc1734d");
  expect(options).toEqual([]);
  expect(renderToStaticMarkup(<AddCard initialOpen skipOptions={options} onAdd={() => {}} />)).not.toContain("skip-picker");
});

test("submit passes the title and skip, then the next form is fresh", () => {
  const calls: [string, string[]][] = [];
  const onAdd = (t: string, s: string[]) => calls.push([t, s]);
  const fresh = submitAddCard("  New card ", [TO_TEST], onAdd);
  expect(calls).toEqual([["New card", [TO_TEST]]]);
  expect(fresh).toEqual({ title: "", skip: [] });
  expect(submitAddCard("   ", [TO_TEST], onAdd)).toEqual({ title: "", skip: [] });
  expect(calls).toHaveLength(1);
});

test("tile shows the skipped indicator, none when empty", () => {
  const card = { id: "c1", title: "Hi", description: "", columnId: "col_fdc888c3ed" } as unknown as Card;
  const base = { project: "/p", card, onOpen: () => {} };
  const html = renderToStaticMarkup(<CardTile {...base} skipped={["To Test"]} />);
  expect(html).toContain('title="Colonnes sautées : To Test"');
  expect(html).toContain('aria-label="Colonnes sautées : To Test"');
  expect(renderToStaticMarkup(<CardTile {...base} skipped={["To Test", "Merge"]} />)).toContain("Colonnes sautées : To Test, Merge");
  expect(renderToStaticMarkup(<CardTile {...base} skipped={[]} />)).not.toContain("card-skipped");
  expect(renderToStaticMarkup(<CardTile {...base} />)).not.toContain("card-skipped");
});

test("createCard sends skipColumnIds only when non-empty", async () => {
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "x" }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await api.createCard("/p", "col_fdc888c3ed", "t", "", [TO_TEST]);
    await api.createCard("/p", "col_fdc888c3ed", "t", "", []);
    await api.createCard("/p", "col_fdc888c3ed", "t");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(bodies[0]?.skipColumnIds).toEqual([TO_TEST]);
  expect("skipColumnIds" in (bodies[1] ?? {})).toBe(false);
  expect("skipColumnIds" in (bodies[2] ?? {})).toBe(false);
});
