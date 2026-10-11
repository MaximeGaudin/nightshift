import { expect, test } from "bun:test";
import { pendingIds, pendingMarker, resolvePending } from "../src/shared/pendingImages.ts";

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
