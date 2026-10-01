import { expect, test } from "bun:test";
import { cardScreenshots, isCardScreenshot, screenshotUrl } from "../src/shared/screenshots.ts";

test("shared-is-card-screenshot", () => {
  expect(isCardScreenshot("/w/nightshift-screenshots/01-x.png", "card_a")).toBe(true);
  expect(isCardScreenshot("/h/screenshots/card_a/01-x.png", "card_a")).toBe(true);
  expect(isCardScreenshot("/h/screenshots/card_b/01-x.png", "card_a")).toBe(false);
  expect(isCardScreenshot("/h/screenshots/card_a/sub/01-x.png", "card_a")).toBe(false);
  expect(isCardScreenshot("https://x/a.png", "card_a")).toBe(false);
  expect(isCardScreenshot("data:image/png;base64,AAAA", "card_a")).toBe(false);
  expect(isCardScreenshot("nightshift-screenshots/a.png", "card_a")).toBe(false);
  expect(isCardScreenshot("/w/nightshift-screenshots/a.jpg", "card_a")).toBe(false);
});

test("shared-is-card-screenshot cardScreenshots and screenshotUrl", () => {
  const d = "![One](/w/nightshift-screenshots/1.png) x ![](/h/screenshots/card_a/2.png) ![N](https://x/3.png) ![O](/h/screenshots/card_b/4.png)";
  expect(cardScreenshots(d, "card_a")).toEqual([
    { alt: "One", file: "/w/nightshift-screenshots/1.png" },
    { alt: "Capture", file: "/h/screenshots/card_a/2.png" },
  ]);
  expect(screenshotUrl("my proj", "card_a", "/a b/1.png")).toBe(
    "/api/cards/card_a/screenshot?project=my%20proj&file=%2Fa%20b%2F1.png",
  );
});
