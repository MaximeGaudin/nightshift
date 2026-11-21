import { expect, test } from "bun:test";
import { applyProxyEnv, parseEnvScript, quotaFromSummary } from "../src/server/teamclaude.ts";

test("teamclaude-parse-env: export forms, unset, and ignored lines", () => {
  const out = parseEnvScript(
    [
      "export HTTPS_PROXY=http://127.0.0.1:3456",
      "export NO_PROXY='localhost,127.0.0.1,::1'",
      "export NODE_EXTRA_CA_CERTS='/tmp/a b'",
      "export QUOTED='it'\\''s'",
      'export DOUBLE="x"',
      "unset ANTHROPIC_BASE_URL",
      "echo hi",
      "export 1BAD=x",
      "export EVIL=$(rm -rf ~)",
      "# comment",
      "",
    ].join("\n"),
  );
  expect(out.set).toEqual({
    HTTPS_PROXY: "http://127.0.0.1:3456",
    NO_PROXY: "localhost,127.0.0.1,::1",
    NODE_EXTRA_CA_CERTS: "/tmp/a b",
    QUOTED: "it's",
    DOUBLE: "x",
  });
  expect(out.unset).toEqual(["ANTHROPIC_BASE_URL"]);
});

test("teamclaude-parse-env: the env applied keeps the base, overrides, and removes the unset names", () => {
  const env = applyProxyEnv(
    { PATH: "/bin", ANTHROPIC_BASE_URL: "x", HTTPS_PROXY: "old" },
    parseEnvScript("export HTTPS_PROXY=new\nunset ANTHROPIC_BASE_URL"),
  );
  expect(env).toEqual({ PATH: "/bin", HTTPS_PROXY: "new" });
});

const SUMMARY = {
  accounts: [
    { name: "a", type: "oauth", disabled: false, buckets: {} },
    { name: "b", type: "oauth", disabled: true, buckets: {} },
  ],
  aggregate: {
    fiveHour: { utilization: 0.4, remaining: 0.6, knownAccounts: 1, nextResetAt: 1791193200000 },
    weeklyShared: { utilization: 0.7, remaining: 0.3, knownAccounts: 1, nextResetAt: 1791237600000 },
    weeklySonnet: null,
    weeklyFable: null,
  },
};

test("teamclaude-quota-mapping: pooled windows, account count, source", () => {
  expect(quotaFromSummary(SUMMARY, "T")).toEqual({
    at: "T",
    source: "teamclaude",
    fiveHour: { utilization: 0.4, resetsAt: 1791193200 },
    sevenDay: { utilization: 0.7, resetsAt: 1791237600 },
    accounts: 1,
  });
});

test("teamclaude-quota-mapping: a null reset or aggregate drops the window, no aggregate is null", () => {
  const snap = quotaFromSummary(
    { ...SUMMARY, aggregate: { ...SUMMARY.aggregate, fiveHour: { utilization: 0.2, nextResetAt: null }, weeklyShared: null } },
    "T",
  );
  expect(snap).toEqual({ at: "T", source: "teamclaude", accounts: 1 });
  expect(quotaFromSummary({ accounts: [] }, "T")).toBeNull();
  expect(quotaFromSummary("nope", "T")).toBeNull();
});
