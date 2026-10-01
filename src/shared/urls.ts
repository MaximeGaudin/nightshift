/**
 * Returns `raw` when it is an absolute http: or https: URL without whitespace or control characters, else null.
 * Used wherever a URL coming from an agent, the API or nightshift.json could end up in an href.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return null;
  }
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? raw : null;
  } catch {
    return null;
  }
}
