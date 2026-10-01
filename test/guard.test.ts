import { expect, test } from "bun:test";
import { checkRequest } from "../src/server/guard.ts";

const P = 4545;
const req = (headers: Record<string, string>, method = "GET", body?: string) =>
  new Request("http://x/api/settings", { method, headers, body });

test("guard-host rejects foreign hosts and ports", async () => {
  for (const host of [`evil.com:${P}`, `localhost:${P + 1}`, "localhost", `127.0.0.1.evil.com:${P}`]) {
    const res = checkRequest(req({ host }), P);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Forbidden host" });
  }
  expect(checkRequest(new Request("http://x/"), P)?.status).toBe(403);
});

test("guard-host accepts loopback names on the right port", () => {
  for (const host of [`localhost:${P}`, `127.0.0.1:${P}`, `[::1]:${P}`, `LocalHost:${P}`]) {
    expect(checkRequest(req({ host }), P)).toBeNull();
  }
});

test("guard-origin rejects foreign and null origins", async () => {
  for (const origin of ["http://evil.com", "null", `http://evil.com:${P}`, `https://localhost:${P}`, "http://localhost:1"]) {
    const res = checkRequest(req({ host: `localhost:${P}`, origin }), P);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Forbidden origin" });
  }
});

test("guard-origin accepts the server origin or none", () => {
  expect(checkRequest(req({ host: `localhost:${P}`, origin: `http://localhost:${P}` }), P)).toBeNull();
  expect(checkRequest(req({ host: `127.0.0.1:${P}`, origin: `http://[::1]:${P}` }), P)).toBeNull();
  expect(checkRequest(req({ host: `localhost:${P}` }), P)).toBeNull();
});

test("guard-content-type requires JSON on POST, PUT and PATCH", async () => {
  const host = `localhost:${P}`;
  for (const method of ["POST", "PUT", "PATCH"]) {
    for (const headers of [
      { host, "content-type": "text/plain" },
      { host, "content-type": "application/x-www-form-urlencoded" },
      { host },
    ]) {
      for (const body of [undefined, "{}"]) {
        const res = checkRequest(req(headers, method, body), P);
        expect(res?.status).toBe(415);
        expect(await res?.json()).toEqual({ error: "Content-Type must be application/json" });
      }
    }
    expect(checkRequest(req({ host, "content-type": "application/json; charset=utf-8" }, method, "{}"), P)).toBeNull();
    expect(checkRequest(req({ host, "content-type": "application/json" }, method), P)).toBeNull();
  }
  expect(checkRequest(req({ host }), P)).toBeNull();
  expect(checkRequest(req({ host }, "DELETE"), P)).toBeNull();
});
