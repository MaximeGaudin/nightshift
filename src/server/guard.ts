/** Local HTTP guard: blocks DNS rebinding (Host), cross-site requests (Origin) and "simple" CSRF requests (Content-Type). */

/** An error with the HTTP status to answer with (404 for an unknown card, project or skill). Any other Error is a 400. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const deny = (status: number, error: string) => Response.json({ error }, { status });

/** Returns null when the request is accepted, otherwise the JSON error response to send. */
export function checkRequest(req: Request, port: number): Response | null {
  const host = req.headers.get("host")?.toLowerCase();
  if (!host || !HOSTS.some((h) => host === `${h}:${port}`)) return deny(403, "Forbidden host");

  const origin = req.headers.get("origin");
  if (origin !== null) {
    const o = origin.toLowerCase();
    if (!HOSTS.some((h) => o === `http://${h}:${port}`)) return deny(403, "Forbidden origin");
  }

  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return deny(415, "Content-Type must be application/json");
  }
  return null;
}
