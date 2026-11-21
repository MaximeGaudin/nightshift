// Generic layered resolution: first layer that answers wins. Pure, no I/O.
// Shared by the effort (and agent features) resolvers; a "smart" layer can be inserted between column and settings.

export interface Layer<T, S extends string> {
  source: S;
  /** `undefined`: no opinion, try the next layer. `null`: stop here and pass nothing (value undefined). */
  value: T | undefined | null;
}

export function resolveLayers<T, S extends string>(
  layers: Layer<T, S>[],
  fallback: { source: S; value: T | undefined },
): { value: T | undefined; source: S } {
  for (const l of layers) {
    if (l.value === null) return { value: undefined, source: l.source };
    if (l.value !== undefined) return { value: l.value, source: l.source };
  }
  return { value: fallback.value, source: fallback.source };
}
