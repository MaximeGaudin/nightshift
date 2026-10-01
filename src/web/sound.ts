import type { AttentionKind } from "../shared/types.ts";

/** Unlocks browser audio on the first user gesture. Stub: implemented by the sound task. */
export function installAudioUnlock(): void {}

/** Plays the sound for an attention event. Stub: implemented by the sound task. */
export function notifyAttention(kind: AttentionKind): void {
  void kind;
}

/** Collapses attention events pushed within `windowMs` into one `play` call. Stub: plays each push at once. */
export function createAttentionBatcher(
  play: (k: AttentionKind) => void,
  windowMs: number,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
): { push(kind: AttentionKind): void } {
  void windowMs;
  void setTimer;
  return { push: (kind) => play(kind) };
}
