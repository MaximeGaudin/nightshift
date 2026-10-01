import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sequenceLabel } from "../src/shared/sequence.ts";
import type { Card, ProjectSnapshot } from "../src/shared/types.ts";
import { isSequential, SequenceControl } from "../src/web/App.tsx";
import { CardTile } from "../src/web/CardTile.tsx";

const card = { id: "card_1", title: "Hello", description: "", columnId: "backlog" } as unknown as Card;
const other = { ...card, id: "card_2" } as Card;
const board = { name: "b", columns: [], cards: [card, other] };
const snapWith = (extra: object) => ({ path: "/p", board, live: {}, ...extra }) as unknown as ProjectSnapshot;
const render = (snap: ProjectSnapshot) => renderToStaticMarkup(<SequenceControl snap={snap} guard={() => {}} />);
const tile = (c: Card, snap: ProjectSnapshot) =>
  renderToStaticMarkup(
    <CardTile
      project="/p"
      card={c}
      dragging={false}
      onOpen={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      sequential={isSequential(snap, c.id)}
    />,
  );

test("seq-ui-button", () => {
  for (const [status, icon] of [
    ["stopped", "icon-play"],
    ["active", "icon-pause"],
    ["paused", "icon-play"],
  ] as const) {
    const sequence = { status, ...(status === "stopped" ? {} : { cardId: "card_1" }) };
    const snap = snapWith({ sequence });
    const html = render(snap);
    expect(html).toContain(icon);
    const label = sequenceLabel(sequence, board as never);
    expect(html).toContain(`title="${label.replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("sequence-notice");
  }
  expect(render(snapWith({ sequence: { status: "stopped" }, agentsDisabled: true }))).toMatch(/<button[^>]*disabled/);
  expect(render(snapWith({ sequence: { status: "stopped" }, lockedBy: 42 }))).toMatch(/<button[^>]*disabled/);

  const notice = render(snapWith({ sequence: { status: "paused", cardId: "card_1", notice: "en erreur : boom" } }));
  expect(notice).toContain('class="sequence-notice" role="status"');
  expect(notice).toContain("en erreur : boom");
});

test("seq-ui-badge", () => {
  const stopped = snapWith({ sequence: { status: "stopped", cardId: "card_1" } });
  expect(tile(card, stopped)).not.toContain("sequence-badge");
  for (const status of ["active", "paused"]) {
    const snap = snapWith({ sequence: { status, cardId: "card_1" } });
    expect(tile(card, snap)).toContain("séquentiel");
    expect(tile(other, snap)).not.toContain("séquentiel");
  }
});
