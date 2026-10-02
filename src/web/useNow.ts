import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  if (listeners.size === 0) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Number of subscribers of the shared ticker (tests). */
export function nowSubscribers(): number {
  return listeners.size;
}

/** Current time in ms, refreshed every second by one interval shared by every component using it. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => Date.now(),
  );
}
