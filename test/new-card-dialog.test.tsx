import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pendingMarker } from "../src/shared/pendingImages.ts";

// The real dialog renders in a portal, which a static render drops: show its content in place.
mock.module("../src/web/components/app-dialog.tsx", () => ({
  AppDialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
const { NewCardDialog, insertPendingImages, pendingImagesInText, pendingToSend, removePendingImage } = await import(
  "../src/web/NewCardDialog.tsx"
);

const image = (id: number) => ({ id, file: new File([new Uint8Array(4)], "p.png", { type: "image/png" }), url: `blob:${id}` });

test("new-card-dialog-description-field", () => {
  const html = renderToStaticMarkup(
    <NewCardDialog columns={[{ id: "col_backlog", name: "Backlog", type: "inert" }]} onAdd={() => {}} onClose={() => {}} />,
  );
  expect(html).toContain('id="new-card-description"');
  expect(html).toMatch(/<label[^>]*for="new-card-description"[^>]*>Description<\/label>/);
  expect(html).toContain("<textarea");
});

test("new-card-dialog-insert-markers", () => {
  expect(insertPendingImages("ab", { start: 1, end: 1 }, [1, 2])).toEqual({
    text: `a\n${pendingMarker(1)}\n${pendingMarker(2)}\nb`,
    cursor: 1 + 1 + pendingMarker(1).length + 1 + pendingMarker(2).length + 1,
  });
  // From the title: at the end of the description.
  expect(insertPendingImages("txt", { start: 3, end: 3 }, [3]).text).toBe(`txt\n${pendingMarker(3)}`);
});

test("new-card-dialog-remove-image", () => {
  const text = `a\n${pendingMarker(1)}\n${pendingMarker(2)}\nb`;
  expect(removePendingImage(text, 1)).toBe(`a\n${pendingMarker(2)}\nb`);
  expect(removePendingImage(removePendingImage(text, 1), 2)).toBe("a\nb");
});

test("new-card-dialog-sends-only-markers-left", () => {
  const pending = [image(1), image(2), image(3)];
  // Marker 2 was deleted by hand; the others are sent in text order.
  expect(pendingImagesInText(`${pendingMarker(3)}\nx\n${pendingMarker(1)}`, pending).map((p) => p.id)).toEqual([3, 1]);
});

test("new-card-dialog-send-drops-orphan-markers", () => {
  // Marker 5 has no image (restored by undo after removal): it is not sent as `pending:`.
  const out = pendingToSend(`a\n${pendingMarker(1)}\n${pendingMarker(5)}\nb`, [image(1)]);
  expect(out.description).toBe(`a\n${pendingMarker(1)}\nb`);
  expect([...out.images.keys()]).toEqual([1]);
  // Beyond the cap, the extra images and their markers are dropped instead of failing the whole creation.
  const many = Array.from({ length: 12 }, (_, i) => image(i + 1));
  const capped = pendingToSend(many.map((p) => pendingMarker(p.id)).join("\n"), many);
  expect(capped.images.size).toBe(10);
  expect(capped.description).not.toContain("pending:11");
  expect(capped.description).not.toContain("pending:12");
});
