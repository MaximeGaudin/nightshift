import { expect, test } from "bun:test";
import { resolveLayers } from "../src/shared/resolve.ts";

const fb = { source: "default", value: "d" } as const;

test("first layer with a value wins", () => {
  expect(
    resolveLayers(
      [
        { source: "a", value: undefined },
        { source: "b", value: "x" },
        { source: "c", value: "y" },
      ],
      fb,
    ),
  ).toEqual({
    value: "x",
    source: "b",
  });
});

test("null stops resolution with no value", () => {
  expect(
    resolveLayers(
      [
        { source: "a", value: undefined },
        { source: "b", value: null },
        { source: "c", value: "y" },
      ],
      fb,
    ),
  ).toEqual({
    value: undefined,
    source: "b",
  });
});

test("falls back when no layer answers", () => {
  expect(resolveLayers([{ source: "a", value: undefined }], fb)).toEqual({ value: "d", source: "default" });
});
