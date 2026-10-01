import { ATTENTION_PRIORITY, type AttentionKind } from "../shared/types.ts";

const BATCH_WINDOW_MS = 1000;
const PEAK_GAIN = 0.3;
const SILENT_GAIN = 0.0001;

let ctx: AudioContext | null = null;
let unlocked = false;
let installed = false;
let batcher: { push(kind: AttentionKind): void } | null = null;

/**
 * Collapses attention events pushed within `windowMs` into one `play` call.
 * The first push opens a trailing window; later pushes only raise the pending kind
 * by ATTENTION_PRIORITY. When the timer fires, the most urgent kind plays once.
 */
export function createAttentionBatcher(
  play: (k: AttentionKind) => void,
  windowMs: number,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
): { push(kind: AttentionKind): void } {
  let pending: AttentionKind | null = null;
  return {
    push(kind) {
      if (pending !== null) {
        if (ATTENTION_PRIORITY[kind] > ATTENTION_PRIORITY[pending]) pending = kind;
        return;
      }
      pending = kind;
      setTimer(() => {
        const k = pending;
        pending = null;
        if (k !== null) play(k);
      }, windowMs);
    },
  };
}

/** Unlocks browser audio on the first user gesture. Idempotent. */
export function installAudioUnlock(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const unlock = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    try {
      if (!ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
      }
      if (ctx.state === "suspended") void ctx.resume();
      unlocked = true;
    } catch {
      // Audio unavailable: stay locked, notifications are dropped.
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Plays the sound for an attention event. Dropped until audio is unlocked. */
export function notifyAttention(kind: AttentionKind): void {
  if (!unlocked || !ctx) return;
  batcher ??= createAttentionBatcher(synthesize, BATCH_WINDOW_MS);
  batcher.push(kind);
}

/** One enveloped oscillator note on the shared context. */
function tone(
  ac: AudioContext,
  type: OscillatorType,
  start: number,
  duration: number,
  freqFrom: number,
  freqTo: number,
  peak: number,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, start);
  if (freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(freqTo, start + duration);
  const level = Math.min(peak, PEAK_GAIN);
  gain.gain.setValueAtTime(SILENT_GAIN, start);
  gain.gain.exponentialRampToValueAtTime(level, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, start + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function synthesize(kind: AttentionKind): void {
  const ac = ctx;
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume();
  const t = ac.currentTime + 0.01;
  switch (kind) {
    case "inert":
      // Soft chime: C6 then E6 (major third), quiet sine.
      tone(ac, "sine", t, 0.18, 1046.5, 1046.5, 0.12);
      tone(ac, "sine", t + 0.12, 0.3, 1318.5, 1318.5, 0.12);
      break;
    case "question":
      // Two distinct rising notes; the second glides upward like a question.
      tone(ac, "triangle", t, 0.16, 660, 660, 0.22);
      tone(ac, "triangle", t + 0.2, 0.3, 880, 1175, 0.22);
      break;
    case "error":
      // Low tone sliding down. Combined peak stays at 0.3.
      tone(ac, "square", t, 0.55, 330, 150, 0.1);
      tone(ac, "triangle", t, 0.55, 165, 75, 0.2);
      break;
  }
}
