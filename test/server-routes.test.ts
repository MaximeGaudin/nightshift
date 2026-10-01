import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts.
let srv: ChildServer;
let dir = "";
const proj = () => `project=${encodeURIComponent(dir)}`;
const snapshot = () => srv.call(`/api/project?${proj()}`).then((r) => r.json());
const raw = (path: string, method: string, body: string) =>
  fetch(srv.base + path, { method, headers: { "content-type": "application/json" }, body });

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  const r = await srv.call("/api/projects/open", { body: { path: dir } });
  expect(r.status).toBe(200);
});
afterAll(() => srv?.stop());

test("routes-invalid-json malformed body is a 400 and creates nothing", async () => {
  const r = await raw("/api/cards", "POST", "{oops");
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBe("Invalid JSON body");
  const withProject = await raw("/api/cards", "POST", `{"project":${JSON.stringify(dir)}, oops`);
  expect(withProject.status).toBe(400);
  expect((await snapshot()).board.cards).toHaveLength(0);
});

test("routes-invalid-json non-object bodies are refused, empty body is accepted", async () => {
  for (const body of ["[]", "42", "null", '"x"']) expect((await raw("/api/cards", "POST", body)).status).toBe(400);
  // Empty body is {}: the handler runs.
  expect((await raw("/api/settings", "PUT", "")).status).toBe(200);
  expect((await snapshot()).board.cards).toHaveLength(0);
});

test("routes-unknown-project unknown or missing project is refused and writes nothing", async () => {
  const other = mkdtempSync(join(srv.tmp, "other-"));
  const unknown = await srv.call(`/api/project?project=${encodeURIComponent(other)}`);
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe("Unknown project");
  const write = await srv.call("/api/cards", { body: { project: other, title: "x" } });
  expect(write.status).toBe(400);
  const missing = await srv.call("/api/project");
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toBe("Missing project");
  expect(existsSync(join(other, "nightshift.json"))).toBe(false);
  expect(existsSync(join(srv.tmp, "nightshift.json"))).toBe(false);
});

const putBoard = (body: object) => srv.call("/api/board", { method: "PUT", body: { project: dir, ...body } });

test("routes-validation board: no column, held cards, malformed or duplicate columns are refused", async () => {
  const none = await putBoard({ columns: [] });
  expect(none.status).toBe(400);
  expect((await none.json()).error).toBe("A board needs at least one column");

  const board = (await snapshot()).board;
  const first = board.columns[0];
  const added = await putBoard({ columns: [{ id: first.id, name: first.name, type: "inert" }, { name: "Extra" }] });
  expect(added.status).toBe(200);
  const cols = (await added.json()).board.columns;
  const extra = cols.find((c: { name: string }) => c.name === "Extra");
  const made = await srv.call("/api/cards", { body: { project: dir, columnId: extra.id, title: "held" } });
  expect(made.status).toBe(200);
  const drop = await putBoard({ columns: cols.filter((c: { id: string }) => c.id !== extra.id) });
  expect(drop.status).toBe(400);
  expect((await drop.json()).error).toMatch(/Column still holds cards/);

  for (const columns of [[null], ["x"], [[]], [{ name: "A", instructions: 3 }], [{ id: 5, name: "A" }]]) {
    const r = await putBoard({ columns });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Column 1/);
  }
  const dup = await putBoard({
    columns: [
      { id: "same", name: "A" },
      { id: "same", name: "B" },
    ],
  });
  expect(dup.status).toBe(400);
  expect((await dup.json()).error).toBe('Duplicate column id "same"');
  expect((await snapshot()).board.columns.map((c: { id: string }) => c.id)).toEqual(cols.map((c: { id: string }) => c.id));
});

test("routes-validation cards: wrongly typed fields are refused", async () => {
  const before = (await snapshot()).board.cards.length;
  for (const body of [{ title: {} }, { title: 5 }, { description: [] }, { columnId: 7 }]) {
    const r = await srv.call("/api/cards", { body: { project: dir, ...body } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/must be a string/);
  }
  const unknown = await srv.call("/api/cards", { body: { project: dir, columnId: "nope" } });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe("Unknown column");
  expect((await snapshot()).board.cards).toHaveLength(before);

  const ok = await srv.call("/api/cards", { body: { project: dir, title: "typed" } });
  const { id } = await ok.json();
  const columns = (await snapshot()).board.columns;
  for (const body of [{}, { columnId: 3 }, { columnId: columns[0].id, index: "1" }, { columnId: columns[0].id, index: 1.5 }]) {
    const r = await srv.call(`/api/cards/${id}/move`, { body: { project: dir, ...body } });
    expect(r.status).toBe(400);
  }
  const moved = await srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId: columns[0].id, index: 0 } });
  expect(moved.status).toBe(200);
  for (const body of [{ command: {} }, { command: "x", url: 4 }]) {
    const r = await srv.call(`/api/cards/${id}/test`, { method: "PUT", body: { project: dir, ...body } });
    expect(r.status).toBe(400);
  }
  const patch = await srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, title: {} } });
  expect(patch.status).toBe(400);
  const card = (await snapshot()).board.cards.find((c: { id: string }) => c.id === id);
  expect(card.title).toBe("typed");
  expect(card.test).toBeUndefined();
});

test("routes-validation skills: bad name refused, PUT /api/skill needs string name and content", async () => {
  const bad = await srv.call("/api/skills", { body: { project: dir, name: "Bad Name" } });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBeString();
  const notString = await srv.call("/api/skills", { body: { project: dir, name: {} } });
  expect(notString.status).toBe(400);

  const made = await srv.call("/api/skills", { body: { project: dir, name: "good-skill", description: "d", body: "hello" } });
  expect(made.status).toBe(200);
  const read = () => srv.call(`/api/skill?${proj()}&name=good-skill`).then((r) => r.json());
  const before = (await read()).content;
  expect(before).toContain("hello");

  for (const body of [{ name: "good-skill" }, { name: "good-skill", content: 4 }, { content: "x" }, { name: 3, content: "x" }]) {
    const r = await srv.call("/api/skill", { method: "PUT", body: { project: dir, ...body } });
    expect(r.status).toBe(400);
  }
  expect((await read()).content).toBe(before);
  const ok = await srv.call("/api/skill", { method: "PUT", body: { project: dir, name: "good-skill", content: `${before}more` } });
  expect(ok.status).toBe(200);
  expect((await read()).content).toBe(`${before}more`);
});
