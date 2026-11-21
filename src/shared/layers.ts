// Layered resolution shared by every per-run option (agent features, effort, a future smart mode).
// Pure, no I/O. The caller orders the layers from strongest to weakest, so a new layer is one more entry.

export type LayerSource = "card" | "column" | "smart" | "settings" | "default";

export interface Layer<T> {
  source: LayerSource;
  value: T | undefined;
}

/** The first layer whose value is not `undefined` wins, `false` and `""` included. Otherwise the fallback. */
export function resolveLayered<T>(layers: Layer<T>[], fallback: T): { value: T; source: LayerSource } {
  for (const l of layers) if (l.value !== undefined) return { value: l.value, source: l.source };
  return { value: fallback, source: "default" };
}
