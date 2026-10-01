import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../src/shared/types.ts";
import { Markdown } from "../src/web/markdown.tsx";
import { handleLightboxKey, renderCardImage } from "../src/web/Screenshot.tsx";
import { TestPanel } from "../src/web/TestPanel.tsx";

const shot = "/work/nightshift-screenshots/card_a-1.png";

test("card-screenshot-renders-endpoint", () => {
  const source = `![Vue finale](${shot})\n\n![ext](https://example.com/x.png)`;
  const html = renderToStaticMarkup(<Markdown source={source} renderImage={renderCardImage("/p", "card_a")} />);
  expect(html).toContain(`<img src="/api/cards/card_a/screenshot?project=%2Fp&amp;file=${encodeURIComponent(shot)}"`);
  expect(html).toContain("<figcaption>Vue finale</figcaption>");
  expect(html).toContain("![ext](https://example.com/x.png)");
  expect(html).not.toContain('example.com/x.png"');
});

test("test-panel-no-screenshots", () => {
  const card = {
    id: "card_a",
    description: `![Vue](${shot})`,
    test: { command: "bun test" },
  } as unknown as Card;
  const html = renderToStaticMarkup(<TestPanel project="/p" card={card} running={false} onError={() => {}} />);
  expect(html).toContain("bun test");
  expect(html).not.toContain("<img");
});

test("lightbox-escape-stops-propagation", () => {
  const calls: string[] = [];
  const ev = (key: string) => ({
    key,
    preventDefault: () => void calls.push("prevent"),
    stopImmediatePropagation: () => void calls.push("stop"),
  });
  expect(handleLightboxKey(ev("Enter"), () => calls.push("close"))).toBe(false);
  expect(calls).toEqual([]);
  expect(handleLightboxKey(ev("Escape"), () => calls.push("close"))).toBe(true);
  expect(calls).toEqual(["prevent", "stop", "close"]);
});
