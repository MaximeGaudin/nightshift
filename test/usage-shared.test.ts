import { expect, test } from "bun:test";
import { mergeRateLimitInfo, type QuotaSnapshot, quotaLevel } from "../src/shared/usage.ts";

const EXAMPLE = {
  status: "allowed_warning",
  resetsAt: 1791237600,
  rateLimitType: "seven_day",
  utilization: 0.88,
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: {
    five_hour: { utilization: 0.38, resetsAt: 1791193200 },
    seven_day: { utilization: 0.88, resetsAt: 1791237600 },
  },
};
const AT = "2026-10-05T10:00:00.000Z";

test("merge-example", () => {
  expect(mergeRateLimitInfo(null, EXAMPLE, AT)).toEqual({
    fiveHour: { utilization: 0.38, resetsAt: 1791193200 },
    sevenDay: { utilization: 0.88, resetsAt: 1791237600 },
    status: "allowed_warning",
    isUsingOverage: false,
    at: AT,
  });
});

test("merge-keeps-previous", () => {
  const prev = mergeRateLimitInfo(null, EXAMPLE, AT) as QuotaSnapshot;
  const bad = { unifiedWindows: { five_hour: { utilization: "x" } }, status: 42 };
  expect(mergeRateLimitInfo(prev, bad, "later")).toBe(prev);
  for (const info of [null, "str", [], 3, undefined]) expect(mergeRateLimitInfo(prev, info, "later")).toBe(prev);
  expect(mergeRateLimitInfo(null, bad, AT)).toBeNull();
});

test("merge-fallback-top-level", () => {
  const prev = mergeRateLimitInfo(null, EXAMPLE, AT) as QuotaSnapshot;
  const next = mergeRateLimitInfo(prev, { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 100 }, "later") as QuotaSnapshot;
  expect(next.fiveHour).toEqual({ utilization: 0.5, resetsAt: 100 });
  expect(next.sevenDay).toEqual(prev.sevenDay);
  expect(next.at).toBe("later");
});

test("level-thresholds", () => {
  const w = (utilization: number) => ({ utilization, resetsAt: 1 });
  expect(quotaLevel(w(0.74))).toBe("normal");
  expect(quotaLevel(w(0.75))).toBe("warn");
  expect(quotaLevel(w(0.89))).toBe("warn");
  expect(quotaLevel(w(0.9))).toBe("danger");
  expect(quotaLevel(w(0.1), "rejected")).toBe("danger");
});
