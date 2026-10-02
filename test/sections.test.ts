import { describe, expect, test } from "bun:test";
import { applySections, MAX_SECTION_CONTENT, parseSections } from "../src/server/sections.ts";

const edit = (heading: string, content = "", op: "replace" | "append" | "delete" = "replace") => ({ heading, content, op });

describe("applySections", () => {
  const note = "## Brief\n\nDo it.\n\n## Result\n\nold\n\n## Review\n\nok\n";

  test("replaces an existing section and keeps the rest byte for byte", () => {
    const r = applySections(note, [edit("Result", "new")]);
    expect(r.text).toBe("## Brief\n\nDo it.\n\n## Result\n\nnew\n\n## Review\n\nok\n");
    expect(r.applied).toEqual(["Result (replace)"]);
  });

  test("appends a missing section at the end", () => {
    const r = applySections(note, [edit("Questions", "1. Why?")]);
    expect(r.text).toBe(`${note}\n## Questions\n\n1. Why?\n`);
  });

  test("appends a missing section to a note without final newline and to an empty note", () => {
    expect(applySections("## A\n\nx", [edit("B", "y")]).text).toBe("## A\n\nx\n\n## B\n\ny");
    expect(applySections("", [edit("B", "y")]).text).toBe("## B\n\ny");
  });

  test("appends lines at the end of a section body", () => {
    const r = applySections(note, [edit("Result", "- more", "append")]);
    expect(r.text).toBe("## Brief\n\nDo it.\n\n## Result\n\nold\n- more\n\n## Review\n\nok\n");
  });

  test("append on a missing section creates it", () => {
    expect(applySections("## A\n", [edit("B", "y", "append")]).text).toBe("## A\n\n## B\n\ny\n");
  });

  test("deletes a section", () => {
    const r = applySections(note, [edit("Result", "", "delete")]);
    expect(r.text).toBe("## Brief\n\nDo it.\n\n## Review\n\nok\n");
    expect(r.applied).toEqual(["Result (delete)"]);
  });

  test("delete of a missing section is a logged no-op", () => {
    const r = applySections(note, [edit("Nope", "", "delete")]);
    expect(r.text).toBe(note);
    expect(r.applied).toEqual([]);
    expect(r.logs[0]).toContain("not found");
  });

  test("level-3 headings and fenced code stay inside their parent", () => {
    const n = "## A\n\n### Sub\n\nx\n\n```md\n## not a heading\n```\n\n## B\n\nb\n";
    expect(applySections(n, [edit("A", "z")]).text).toBe("## A\n\nz\n\n## B\n\nb\n");
    expect(applySections(n, [edit("Sub", "z")]).text).toBe(`${n}\n## Sub\n\nz\n`.replace("\n\n\n", "\n\n"));
    expect(applySections(n, [edit("not a heading", "z")]).text).toContain("## not a heading\n```\n\n## B\n\nb\n\n## not a heading");
  });

  test("duplicate headings: the first one is edited and logged", () => {
    const n = "## A\n\n1\n\n## A\n\n2\n";
    const r = applySections(n, [edit("A", "x")]);
    expect(r.text).toBe("## A\n\nx\n\n## A\n\n2\n");
    expect(r.logs[0]).toContain("first one");
  });

  test("a heading at the very end", () => {
    expect(applySections("## A\n\nx\n\n## B", [edit("B", "y")]).text).toBe("## A\n\nx\n\n## B\n\ny");
    expect(applySections("## A\n\nx\n\n## B\n", [edit("B", "y")]).text).toBe("## A\n\nx\n\n## B\n\ny\n");
    expect(applySections("## A\n\nx\n\n## B", [edit("B", "y", "append")]).text).toBe("## A\n\nx\n\n## B\ny");
    expect(applySections("## A\n\nx\n\n## B\n", [edit("B", "", "delete")]).text).toBe("## A\n\nx\n");
  });

  test("CRLF notes keep CRLF", () => {
    const n = "## A\r\n\r\nx\r\n\r\n## B\r\n\r\ny\r\n";
    expect(applySections(n, [edit("A", "l1\nl2")]).text).toBe("## A\r\n\r\nl1\r\nl2\r\n\r\n## B\r\n\r\ny\r\n");
    expect(applySections(n, [edit("C", "z")]).text).toBe(`${n}\r\n## C\r\n\r\nz\r\n`);
    expect(applySections(n, [edit("A", "", "delete")]).text).toBe("## B\r\n\r\ny\r\n");
  });

  test("matching is exact after trim, case sensitive", () => {
    expect(applySections("##   Result  \n\nx\n", [edit("Result", "y")]).text).toBe("##   Result  \n\ny\n");
    expect(applySections("## Result\n\nx\n", [edit("result", "y")]).applied).toEqual(["result (replace)"]);
  });

  test("trailing line breaks of the content do not pile up blank lines", () => {
    const n = "## A\n\nx\n\n## B\n";
    const once = applySections(n, [edit("A", "y\n\n")]).text;
    expect(once).toBe("## A\n\ny\n\n## B\n");
    expect(applySections(once, [edit("A", "y\n\n")]).text).toBe(once);
    expect(applySections(n, [edit("A", "z\n", "append")]).text).toBe("## A\n\nx\nz\n\n## B\n");
  });

  test("lines outside the edited section keep their own line endings in a mixed note", () => {
    const n = "## A\r\n\r\nx\n\n## B\r\n\r\ny\r\n";
    expect(applySections(n, [edit("B", "z")]).text).toBe("## A\r\n\r\nx\n\n## B\r\n\r\nz\r\n");
    expect(applySections("## A\r\n\r\nx", [edit("A", "y", "append")]).text).toBe("## A\r\n\r\nx\r\ny");
    expect(applySections("## A\r\n\r\nx", [edit("B", "y")]).text).toBe("## A\r\n\r\nx\r\n\r\n## B\r\n\r\ny");
  });

  test("edits apply in order", () => {
    const r = applySections("## A\n\nx\n", [edit("A", "1"), edit("A", "2", "append")]);
    expect(r.text).toBe("## A\n\n1\n2\n");
  });
});

describe("parseSections", () => {
  test("skips malformed entries and keeps the others", () => {
    const { edits, logs } = parseSections([
      { content: "x" },
      { heading: "A\nB", content: "x" },
      { heading: "   ", content: "x" },
      { heading: "A", content: "x", op: "merge" },
      { heading: "A", content: 12 },
      { heading: "A" },
      null,
      "str",
      { heading: "Ok", content: "fine" },
      { heading: "## Hashes", content: "h", op: "append" },
      { heading: "Gone", op: "delete" },
      { heading: "Big", content: "x".repeat(MAX_SECTION_CONTENT + 1) },
    ]);
    expect(edits).toEqual([
      { heading: "Ok", content: "fine", op: "replace" },
      { heading: "Hashes", content: "h", op: "append" },
      { heading: "Gone", content: "", op: "delete" },
    ]);
    expect(logs).toHaveLength(9);
  });

  test("caps at 50 entries", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ heading: `H${i}`, content: "x" }));
    const { edits, logs } = parseSections(raw);
    expect(edits).toHaveLength(50);
    expect(logs[0]).toContain("first 50");
  });

  test("non-array is ignored, absent is silent", () => {
    expect(parseSections("nope").edits).toEqual([]);
    expect(parseSections("nope").logs).toHaveLength(1);
    expect(parseSections(undefined)).toEqual({ edits: [], logs: [] });
  });
});
