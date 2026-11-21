// Server-side code host of each provider id. Adding one: a module next to this file and one line here.

import type { CodeHost } from "./codehost.ts";
import { github } from "./github.ts";

const hosts = new Map<string, CodeHost>([["github", github]]);

export function codeHostFor(id: string): CodeHost | undefined {
  return hosts.get(id);
}

/** Registers (or, with null, removes) a code host; used by tests to plug a fake one. */
export function registerCodeHost(id: string, impl: CodeHost | null) {
  if (impl) hosts.set(id, impl);
  else hosts.delete(id);
}
