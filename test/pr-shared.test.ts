// Shared pull request contract: settings accessors, `- PR:` lines, merge status, PR body.
import { expect, test } from "bun:test";
import {
  autoMergeOf,
  buildPrBody,
  buildPrTitle,
  MAX_PR_BODY,
  mergeMethodOf,
  parseMergeStatus,
  prUrlOf,
  pullRequestsOf,
  SCREENSHOTS_END,
  SCREENSHOTS_START,
  setSectionPrLine,
  writeMergeStatus,
} from "../src/shared/pullRequests.ts";

test("settings accessors fall back to their defaults", () => {
  expect(pullRequestsOf({})).toBe("auto");
  expect(pullRequestsOf({ pullRequests: "off" })).toBe("off");
  expect(pullRequestsOf({ pullRequests: "bogus" as never })).toBe("auto");
  expect(mergeMethodOf({})).toBe("merge");
  expect(mergeMethodOf({ mergeMethod: "squash" })).toBe("squash");
  expect(autoMergeOf({})).toBe(false);
  expect(autoMergeOf({ autoMerge: true })).toBe(true);
});

test("setSectionPrLine keeps a single PR line and the rest of the section intact", () => {
  const d = "# T\n\n## Review\n\n- Findings: none\n- PR: a\n- PR: old\n- Suite: ok\n\n## Next\n\nx\n";
  const once = setSectionPrLine(d, "Review", "https://github.com/o/r/pull/2");
  const twice = setSectionPrLine(once, "Review", "https://github.com/o/r/pull/2");
  expect(twice).toBe(once);
  expect(once).toBe("# T\n\n## Review\n\n- Findings: none\n- PR: https://github.com/o/r/pull/2\n- Suite: ok\n\n## Next\n\nx\n");
  expect(prUrlOf(once)).toBe("https://github.com/o/r/pull/2");
});

test("setSectionPrLine appends to a section without a PR line, or creates the section", () => {
  expect(setSectionPrLine("## Review\n\n- Findings: none\n\n## Next\n", "Review", "u")).toBe(
    "## Review\n\n- Findings: none\n- PR: u\n\n## Next\n",
  );
  expect(setSectionPrLine("# T\n", "Review", "u")).toBe("# T\n\n## Review\n\n- PR: u\n");
});

test("merge status round-trips and stays a single line", () => {
  const url = "https://github.com/o/r/pull/3";
  let d = "## Result\n\n- Base: main\n";
  d = writeMergeStatus(d, url, "pending");
  d = writeMergeStatus(d, url, "pending");
  expect(d.match(/- PR:/g)?.length).toBe(1);
  expect(parseMergeStatus(d)).toEqual({ url, status: "pending" });
  d = writeMergeStatus(d, url, "auto");
  expect(parseMergeStatus(d)?.status).toBe("auto");
  d = writeMergeStatus(d, url, "ready");
  expect(parseMergeStatus(d)?.status).toBe("ready");
  d = writeMergeStatus(d, url, "merged", "abc1234");
  expect(parseMergeStatus(d)).toEqual({ url, status: "merged", sha: "abc1234" });
  expect(parseMergeStatus("## Merge\n\n- Into: main\n")).toBeUndefined();
});

test("buildPrBody has the summary, DoD, review, card ref and keeps the screenshots block", () => {
  const card = {
    id: "card_x",
    number: 7,
    description:
      "# T\n\n## Definition of done\n\n- [x] it works\n\n## Result\n\n- Worktree: /tmp/w\n- Base: main at abc\n- Commits: abc\n- Tests: ok\n\n## Review\n\n- Findings: none\n",
  };
  const shots = `${SCREENSHOTS_START}\n## Screenshots\n\n![a](https://x/a.png)\n${SCREENSHOTS_END}`;
  const body = buildPrBody(card, `old text\n\n${shots}`);
  expect(body).toContain("## Summary\n\n- Tests: ok");
  expect(body).not.toContain("Worktree:");
  expect(body).toContain("- [x] it works");
  expect(body).toContain("## Review\n\n- Findings: none");
  expect(body).toContain("Nightshift card: #7 (card_x)");
  expect(body.endsWith(shots)).toBe(true);
  expect(body).not.toContain("old text");
});

test("buildPrTitle and buildPrBody use the review's ## Pull request section when the card has one", () => {
  const card = {
    id: "card_y",
    number: 8,
    title: "Logs: events without customer_id",
    description:
      "# T\n\n## Result\n\n- Tests: ok\n\n## Review\n\n- Findings: none\n\n## Pull request\n\nTitle: `fix(archiver): name the customer`\n\n### Summary\n\nNow named.\n\n### How to test\n\n```bash\nmise dev\n```\n",
  };
  const shots = `${SCREENSHOTS_START}\n![a](https://x/a.png)\n${SCREENSHOTS_END}`;
  expect(buildPrTitle(card)).toBe("fix(archiver): name the customer");
  const body = buildPrBody(card, `old\n\n${shots}`);
  expect(body.startsWith("### Summary\n\nNow named.\n\n### How to test")).toBe(true);
  expect(body).not.toContain("Title:");
  expect(body).not.toContain("- Findings: none");
  expect(body).toContain("Nightshift card: #8 (card_y)");
  expect(body.endsWith(shots)).toBe(true);
});

test("without a ## Pull request section, or with a title only, the card title and generated body stay", () => {
  const plain = { id: "c", number: 1, title: "Card", description: "## Result\n\n- Tests: ok\n" };
  expect(buildPrTitle(plain)).toBe("Card");
  expect(buildPrBody(plain)).toContain("## Summary\n\n- Tests: ok");
  const titleOnly = { ...plain, description: `${plain.description}\n## Pull request\n\nTitle: feat: x\n` };
  expect(buildPrTitle(titleOnly)).toBe("feat: x");
  expect(buildPrBody(titleOnly)).toContain("## Summary\n\n- Tests: ok");
  const bodyOnly = { ...plain, description: `${plain.description}\n## Pull request\n\n### Summary\n\nown\n` };
  expect(buildPrTitle(bodyOnly)).toBe("Card");
  expect(buildPrBody(bodyOnly).startsWith("### Summary\n\nown")).toBe(true);
});

test("a ## Pull request body over the limit is cut, keeping the card reference", () => {
  const card = { id: "c", number: 2, description: `## Pull request\n\n${"x".repeat(MAX_PR_BODY + 10)}\n` };
  const body = buildPrBody(card);
  expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY);
  expect(body.endsWith("Nightshift card: #2 (c)")).toBe(true);
});
