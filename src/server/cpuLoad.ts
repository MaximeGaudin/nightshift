import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import type { Settings } from "../shared/types.ts";

/** One `os.cpus()` entry, reduced to what the load needs. */
export interface CpuTimes {
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

const WINDOW = 5;
const DEFAULT_SAMPLE_MS = 2000;

function totals(list: CpuTimes[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const { times } of list) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Utilisation (0-100) of all cores between two readings, or null when no time elapsed. */
export function cpuUsageBetween(prev: CpuTimes[], next: CpuTimes[]): number | null {
  const a = totals(prev);
  const b = totals(next);
  const total = b.total - a.total;
  if (total <= 0) return null;
  const idle = Math.min(Math.max(b.idle - a.idle, 0), total);
  return ((total - idle) / total) * 100;
}

/** Mean of the last WINDOW samples (the oldest fall out), or null when there is none. */
export function windowAverage(samples: number[]): number | null {
  const last = samples.slice(-WINDOW);
  return last.length === 0 ? null : last.reduce((s, v) => s + v, 0) / last.length;
}

/** True when the throttle is on and the known load has reached the limit. An unknown load never blocks. */
export function cpuBlocks(settings: Pick<Settings, "cpuThrottleEnabled" | "cpuThrottleMaxPercent">, load: number | null): boolean {
  return settings.cpuThrottleEnabled && load !== null && load >= settings.cpuThrottleMaxPercent;
}

/**
 * Samples the machine's CPU load every `NIGHTSHIFT_CPU_SAMPLE_MS` (2 s) and averages the last 5 samples (10 s).
 * With `NIGHTSHIFT_CPU_LOAD_FILE` set, each sample is that file's number instead (no averaging; missing or
 * unreadable file: unknown), so tests do not depend on the machine's real load.
 */
export class CpuLoadSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: CpuTimes[] | null = null;
  private samples: number[] = [];
  private value: number | null = null;

  constructor(private readonly opts: { onSample: () => void; intervalMs?: number; file?: string }) {}

  /** Averaged load in percent, or null while unknown. */
  current(): number | null {
    return this.value;
  }

  start() {
    if (this.timer) return;
    this.sample();
    const ms = this.opts.intervalMs ?? (Number(process.env.NIGHTSHIFT_CPU_SAMPLE_MS) || DEFAULT_SAMPLE_MS);
    this.timer = setInterval(() => this.sample(), ms);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sample() {
    this.value = this.read();
    this.opts.onSample();
  }

  private read(): number | null {
    const file = this.opts.file ?? process.env.NIGHTSHIFT_CPU_LOAD_FILE;
    try {
      if (file) {
        const n = Number.parseFloat(readFileSync(file, "utf8"));
        return Number.isFinite(n) ? n : null;
      }
      const now = cpus();
      const prev = this.prev;
      this.prev = now;
      if (!prev || now.length === 0) return windowAverage(this.samples);
      const usage = cpuUsageBetween(prev, now);
      if (usage !== null) this.samples.push(usage);
      this.samples = this.samples.slice(-WINDOW);
      return windowAverage(this.samples);
    } catch {
      return null;
    }
  }
}
