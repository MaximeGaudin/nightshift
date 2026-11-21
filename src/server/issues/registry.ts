// Server-side implementation of each provider listed in PROVIDERS (src/shared/issues.ts).
// Adding a provider: one module next to this file, one PROVIDERS entry, one line here.

import { gitea } from "./gitea.ts";
import { github } from "./github.ts";
import type { IssueProvider } from "./provider.ts";

const providers = new Map<string, IssueProvider>([
  ["github", github],
  ["gitea", gitea],
]);

export function providerFor(id: string): IssueProvider | undefined {
  return providers.get(id);
}

/** Registers (or, with null, removes) a provider; used by tests to plug a fake one. */
export function registerProvider(id: string, impl: IssueProvider | null) {
  if (impl) providers.set(id, impl);
  else providers.delete(id);
}
