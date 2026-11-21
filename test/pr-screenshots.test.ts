import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeScreenshotsSection, SCREENSHOTS_END, SCREENSHOTS_START, syncPrScreenshots } from "../src/server/prScreenshots.ts";
import { screenshotsDir } from "../src/server/screenshots.ts";
import { makeFakeGh } from "./fake-gh.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const tmp = tempDir("ns-pr-shots-test-");
const fake = makeFakeGh(tmp);
const savedGh = process.env.NIGHTSHIFT_GH;
process.env.NIGHTSHIFT_GH = fake.bin;
Object.assign(process.env, fake.env);

afterAll(() => {
  if (savedGh === undefined) delete process.env.NIGHTSHIFT_GH;
  else process.env.NIGHTSHIFT_GH = savedGh;
  removeTempDirs();
});

const CARD = "card_prshots";
const dir = screenshotsDir(CARD);
mkdirSync(dir, { recursive: true });
const home = join(dir, "01-home.png");
const settings = join(dir, "02-settings.png");
writeFileSync(home, PNG);
writeFileSync(settings, Buffer.concat([PNG, Buffer.from([0])]));
const description = `## Screenshots\n\n![Home](${home})\n![Réglages](${settings})\n![Ailleurs](/elsewhere/nightshift-screenshots/x.png)`;
const PR_URL = "https://github.test/o/r/pull/7";
const assetUrl = (name: string) => `https://github.test/o/r/releases/download/nightshift-screenshots/${CARD}-${name}`;

let logs: string[] = [];
const log = (t: string) => logs.push(t);
const sync = () => syncPrScreenshots({ projectPath: tmp, cardId: CARD, description, log });
const kinds = () => fake.calls().map((c) => c.args.slice(0, 2).join(" "));

beforeEach(() => {
  logs = [];
});

test("merge-append", () => {
  const body = "Fixes #3.\n\nSome text";
  const out = mergeScreenshotsSection(body, [
    { alt: "A", url: "https://x/a.png" },
    { alt: "B", url: "https://x/b.png" },
  ]);
  expect(out.startsWith(`${body}\n\n`)).toBe(true);
  expect(out.slice(body.length)).toBe(
    `\n\n${SCREENSHOTS_START}\n## Screenshots\n\n![A](https://x/a.png)\n![B](https://x/b.png)\n${SCREENSHOTS_END}`,
  );
  expect(mergeScreenshotsSection("", [{ alt: "A", url: "u" }])).toBe(`${SCREENSHOTS_START}\n## Screenshots\n\n![A](u)\n${SCREENSHOTS_END}`);
});

test("merge-replace", () => {
  const body = `Intro\n\n${SCREENSHOTS_START}\n## Screenshots\n\n![Old](o)\n${SCREENSHOTS_END}\n\nOutro`;
  const once = mergeScreenshotsSection(body, [{ alt: "New", url: "n" }]);
  expect(once).toBe(`Intro\n\n${SCREENSHOTS_START}\n## Screenshots\n\n![New](n)\n${SCREENSHOTS_END}\n\nOutro`);
  expect(mergeScreenshotsSection(once, [{ alt: "New", url: "n" }])).toBe(once);
});

test("sync-open-pr", async () => {
  fake.setState({ pr: { url: PR_URL, body: "Body of the PR", state: "OPEN" }, release: null });
  await sync();
  expect(logs).toEqual([]);
  const calls = fake.calls();
  const create = calls.find((c) => c.args[0] === "release" && c.args[1] === "create");
  expect(create?.args).toContain("--prerelease");
  const upload = calls.find((c) => c.args[1] === "upload");
  expect(upload?.args.filter((a) => a.endsWith(".png")).map((a) => a.split("/").pop())).toEqual([
    `${CARD}-01-home.png`,
    `${CARD}-02-settings.png`,
  ]);
  const st = fake.state();
  expect(st.release?.assets.map((a) => a.name)).toEqual([`${CARD}-01-home.png`, `${CARD}-02-settings.png`]);
  expect(st.pr?.body).toBe(
    `Body of the PR\n\n${SCREENSHOTS_START}\n## Screenshots\n\n![Home](${assetUrl("01-home.png")})\n![Réglages](${assetUrl("02-settings.png")})\n${SCREENSHOTS_END}`,
  );
  expect(calls.find((c) => c.args[1] === "edit")?.args).toEqual(["pr", "edit", PR_URL, "--body-file", "-"]);
});

test("sync-idempotent", async () => {
  const before = fake.state();
  fake.setState(before);
  await sync();
  expect(logs).toEqual([]);
  expect(kinds()).not.toContain("release upload");
  expect(kinds()).not.toContain("pr edit");
  expect(fake.state()).toEqual(before);
});

test("sync-no-pr", async () => {
  fake.setState({ pr: null, release: null });
  await sync();
  expect(kinds()).toEqual(["pr view"]);
  fake.setState({ pr: { url: PR_URL, body: "x", state: "CLOSED" }, release: null });
  await sync();
  expect(kinds()).toEqual(["pr view"]);
  expect(fake.state().pr?.body).toBe("x");
  expect(logs).toEqual([]);
});

test("sync-no-captures", async () => {
  fake.setState({ pr: { url: PR_URL, body: "x", state: "OPEN" } });
  await syncPrScreenshots({ projectPath: tmp, cardId: CARD, description: "![A](/elsewhere/a.png)", log });
  expect(fake.calls()).toEqual([]);
  expect(logs).toEqual([]);
});

test("sync-gh-missing", async () => {
  process.env.NIGHTSHIFT_GH = join(tmp, "does-not-exist");
  try {
    await sync();
  } finally {
    process.env.NIGHTSHIFT_GH = fake.bin;
  }
  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith("Screenshots non ajoutés à la PR");
});

test("sync-upload-fails", async () => {
  fake.setState({ pr: { url: PR_URL, body: "x", state: "OPEN" }, release: { assets: [] }, failUpload: true });
  await sync();
  expect(kinds()).not.toContain("pr edit");
  expect(fake.state().pr?.body).toBe("x");
  expect(logs).toEqual(["Screenshots non ajoutés à la PR : HTTP 422: upload refused"]);
});
