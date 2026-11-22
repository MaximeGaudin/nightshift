import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CpuLoadSampler, cpuBlocks, cpuUsageBetween, windowAverage } from "../src/server/cpuLoad.ts";

const core = (idle: number, busy: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

test("cpu-load-math: usage between readings, window of 5, unknown without a delta", () => {
  expect(cpuUsageBetween([core(0, 0), core(0, 0)], [core(25, 75), core(25, 75)])).toBe(75);
  expect(cpuUsageBetween([core(5, 5)], [core(5, 5)])).toBeNull();
  expect(windowAverage([])).toBeNull();
  expect(windowAverage([100, 0, 0, 0, 0, 50])).toBe(10);
});

test("cpu-load-block: unknown load and disabled throttle never block", () => {
  const on = { cpuThrottleEnabled: true, cpuThrottleMaxPercent: 85 };
  expect(cpuBlocks(on, null)).toBe(false);
  expect(cpuBlocks(on, 84)).toBe(false);
  expect(cpuBlocks(on, 85)).toBe(true);
  expect(cpuBlocks({ ...on, cpuThrottleEnabled: false }, 99)).toBe(false);
});

test("cpu-load-file: the file's number is the load, a missing file is unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-cpu-"));
  const file = join(dir, "load");
  let samples = 0;
  const s = new CpuLoadSampler({ file, intervalMs: 20, onSample: () => samples++ });
  s.start();
  expect(s.current()).toBeNull();
  writeFileSync(file, "92");
  return new Promise<void>((done) =>
    setTimeout(() => {
      expect(s.current()).toBe(92);
      rmSync(file);
      setTimeout(() => {
        expect(s.current()).toBeNull();
        expect(samples).toBeGreaterThan(2);
        s.stop();
        rmSync(dir, { recursive: true, force: true });
        done();
      }, 80);
    }, 80),
  );
});
