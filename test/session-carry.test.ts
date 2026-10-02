import { describe, expect, test } from "bun:test";
import { contextTokensOf, decideCarry } from "../src/server/sessionCarry.ts";
import type { LastRun } from "../src/shared/types.ts";

const limits = { carryMaxTokens: 80000, carryMaxAgeMinutes: 5 };
const NOW = Date.parse("2026-01-01T12:00:00Z");
const run = (tokens: number | undefined, minutesAgo: number): LastRun => ({
  columnId: "c",
  status: "success",
  at: new Date(NOW - minutesAgo * 60000).toISOString(),
  ...(tokens !== undefined ? { contextTokens: tokens } : {}),
});

describe("decideCarry", () => {
  test("auto under both limits continues and logs", () => {
    expect(decideCarry("auto", run(62000, 2), limits, NOW)).toEqual({
      carry: true,
      log: "Continuing the card's session (62k tokens, 2 min old)",
    });
  });
  test("boundaries: exactly the token limit continues, age equal to the max starts fresh", () => {
    expect(decideCarry("auto", run(80000, 1), limits, NOW).carry).toBe(true);
    expect(decideCarry("auto", run(1000, 5), limits, NOW)).toEqual({ carry: false, log: "Fresh session: last run 5 min ago" });
  });
  test("over the limits starts fresh, token reason wins", () => {
    expect(decideCarry("auto", run(160000, 1), limits, NOW).log).toBe("Fresh session: carried context 160k > 80k");
    expect(decideCarry("auto", run(1000, 14), limits, NOW).log).toBe("Fresh session: last run 14 min ago");
    expect(decideCarry("auto", run(160000, 14), limits, NOW).log).toBe("Fresh session: carried context 160k > 80k");
  });
  test("unknown size starts fresh", () => {
    expect(decideCarry("auto", run(undefined, 1), limits, NOW)).toEqual({
      carry: false,
      log: "Fresh session: carried context size unknown",
    });
    expect(decideCarry("auto", undefined, limits, NOW).carry).toBe(false);
  });
  test("fixed modes ignore size and age and never log", () => {
    expect(decideCarry(true, run(10, 0), limits, NOW)).toEqual({ carry: false });
    expect(decideCarry(undefined, run(900000, 99), limits, NOW)).toEqual({ carry: true });
  });
});

describe("contextTokensOf", () => {
  test("sums the three fields, missing as 0", () => {
    expect(contextTokensOf({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })).toBe(125);
    expect(contextTokensOf({ cache_read_input_tokens: 7 })).toBe(7);
  });
  test("undefined without usage", () => {
    expect(contextTokensOf(undefined)).toBeUndefined();
    expect(contextTokensOf("x")).toBeUndefined();
  });
});
