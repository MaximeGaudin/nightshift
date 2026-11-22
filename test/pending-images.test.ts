import { expect, test } from "bun:test";
import { safeAttachmentName } from "../src/shared/attachments.ts";
import { pendingFileMarker, pendingIds, pendingMarker, pendingRefs, resolvePending } from "../src/shared/pendingImages.ts";

const m = pendingMarker;

test("pending-resolve-success", () => {
  expect(resolvePending(`a\n${m(1)}\nb`, new Map([[1, "/x/p.png"]]))).toBe("a\n![image](/x/p.png)\nb");
});

test("pending-resolve-failure-removes-line", () => {
  const none = new Map<number, string | null>([[1, null]]);
  expect(resolvePending(`${m(1)}\na\nb`, none)).toBe("a\nb");
  expect(resolvePending(`a\n${m(1)}\nb`, none)).toBe("a\nb");
  expect(resolvePending(`a\nb\n${m(1)}`, none)).toBe("a\nb");
  // Missing from the map counts as a failure.
  expect(resolvePending(`a\n${m(2)}\nb`, new Map())).toBe("a\nb");
  // Other text on the marker's line stays.
  expect(resolvePending(`see ${m(1)} here`, none)).toBe("see  here");
  expect(resolvePending(m(1), none)).toBe("");
});

test("pending-exact-id", () => {
  const text = `${m(1)}\n${m(12)}\n${m(1)}`;
  expect(
    resolvePending(
      text,
      new Map([
        [1, "/a.png"],
        [12, "/b.png"],
      ]),
    ),
  ).toBe("![image](/a.png)\n![image](/b.png)\n![image](/a.png)");
  expect(resolvePending(text, new Map([[1, "/a.png"]]))).toBe("![image](/a.png)\n![image](/a.png)");
  expect(pendingIds(text)).toEqual([1, 12]);
  expect(pendingIds("![image](pending:0) ![x](pending:3) ![image](/p.png)")).toEqual([]);
});

test("pending-file-markers", () => {
  const f = pendingFileMarker;
  const text = `a\n${f(1, "spec.pdf")}\n${m(2)}\n${f(3, "x.log")}\nb`;
  expect(pendingRefs(text)).toEqual([
    { id: 1, kind: "file", label: "spec.pdf" },
    { id: 2, kind: "image", label: "image" },
    { id: 3, kind: "file", label: "x.log" },
  ]);
  expect(pendingIds(text)).toEqual([1, 2, 3]);
  const out = resolvePending(
    text,
    new Map([
      [1, { path: "/h/spec-2.pdf", label: "spec-2.pdf" }],
      [2, "/h/p.png"],
      [3, null],
    ]),
  );
  expect(out).toBe("a\n[spec-2.pdf](/h/spec-2.pdf)\n![image](/h/p.png)\nb");
  // A path alone keeps the marker's own name.
  expect(resolvePending(f(4, "n.md"), new Map([[4, "/h/n.md"]]))).toBe("[n.md](/h/n.md)");
  // An image with another label is neither an image nor a file marker.
  expect(pendingIds("![x](pending:3) [bad name](pending:4)")).toEqual([]);
});

test("safe-attachment-name", () => {
  const cases = ["../../x y.txt", ".env", "a\\b.log", "", `${"a".repeat(300)}.txt`, "__.hidden", "été.pdf", "...", "/"];
  for (const raw of cases) {
    const name = safeAttachmentName(raw);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name.startsWith(".")).toBe(false);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true);
  }
  expect(safeAttachmentName("../../x y.txt")).toBe("x_y.txt");
  expect(safeAttachmentName(".env")).toBe("env");
  expect(safeAttachmentName("")).toBe("file");
});
