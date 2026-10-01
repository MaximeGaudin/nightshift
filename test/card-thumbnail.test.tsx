import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { screenshotUrl } from "../src/shared/screenshots.ts";
import type { Card } from "../src/shared/types.ts";
import { CardThumbnail } from "../src/web/CardThumbnail.tsx";

const mk = (id: string, description: string): Card => ({
  id,
  number: 1,
  title: "T",
  description,
  columnId: "c",
  createdAt: "",
  updatedAt: "",
  enteredColumnAt: "",
  history: [],
});

test("thumbnail present/absent", () => {
  const a = "/home/u/x/screenshots/card1/a.png";
  const b = "/home/u/x/screenshots/card1/b.png";
  const withShots = mk("card1", `![A](${a}) text ![B](${b})`);
  const html = renderToStaticMarkup(<CardThumbnail project="/p" card={withShots} />);
  expect(html).toContain("<img");
  expect(html).toContain('draggable="false"');
  expect(html).toContain(`src="${screenshotUrl("/p", "card1", a).replace(/&/g, "&amp;")}"`);
  expect(html).not.toContain(encodeURIComponent(b));
  expect(html).not.toContain("onclick");
  expect(renderToStaticMarkup(<CardThumbnail project="/p" card={mk("card2", "no images")} />)).toBe("");
});
