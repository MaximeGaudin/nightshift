import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "../src/web/components/icon-button.tsx";

test("icon-button-tooltip: aria-label is the label and it renders without a TooltipProvider", () => {
  const html = renderToStaticMarkup(
    <IconButton label="Fermer">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(html).toContain('aria-label="Fermer"');
  expect(html).toContain('type="button"');
  expect(html).toContain("<svg");
});

test("icon-button-tooltip: extra props reach the button", () => {
  const html = renderToStaticMarkup(
    <IconButton label="Supprimer" disabled className="x-test">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(html).toContain("disabled");
  expect(html).toContain("x-test");
});

test("icon-button-tooltip: a disabled button sits in a focusable tooltip trigger", () => {
  const html = renderToStaticMarkup(
    <IconButton label="Videz la colonne avant de la supprimer" disabled>
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(html).toMatch(/^<span[^>]*tabindex="0"[^>]*><button[^>]* disabled=""/);
  expect(html).toContain('aria-label="Videz la colonne avant de la supprimer"');
  const enabled = renderToStaticMarkup(
    <IconButton label="Supprimer">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(enabled).toMatch(/^<button/);
});
