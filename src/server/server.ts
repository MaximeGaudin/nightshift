import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  type Card,
  type Column,
  type ColumnType,
  ensureDoneColumn,
  isDoneColumn,
  normalizeColumnEmoji,
  normalizeColumnParallel,
  type ServerEvent,
} from "../shared/types.ts";
import index from "../web/index.html";
import { Orchestrator } from "./orchestrator.ts";
import { removeScreenshots, resolveScreenshot } from "./screenshots.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { createSkill, listSkills, readSkill, saveSkill } from "./skills.ts";
import { COLUMN_KEYS, newId, unknownFields } from "./store.ts";

export function startServer({ port, development, agents = true }: { port: number; development?: boolean; agents?: boolean }) {
  // `bun --hot` re-runs this module on every change. Reuse the orchestrator from the previous run:
  // a new one would schedule every card a second time next to the old one, which keeps its watchers.
  const g = globalThis as { __nightshift?: { orch: Orchestrator; sockets: Set<ServerWebSocket<unknown>> } };
  if (!g.__nightshift) {
    const orch = new Orchestrator({ agents });
    const sockets = new Set<ServerWebSocket<unknown>>();
    orch.on((e: ServerEvent) => {
      const msg = JSON.stringify(e);
      for (const ws of sockets) ws.send(msg);
    });
    g.__nightshift = { orch, sockets };
  }
  const { orch, sockets } = g.__nightshift;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (e: any) => json({ error: e?.message ?? String(e) }, 400);

  /** Wraps a handler: parses the JSON body and turns thrown errors into 400s. */
  const h =
    (fn: (body: any, url: URL, req: Request & { params: Record<string, string> }) => unknown) =>
    async (req: Request & { params: Record<string, string> }) => {
      try {
        const url = new URL(req.url);
        const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.json().catch(() => ({}));
        const out = await fn(body, url, req);
        return out instanceof Response ? out : json(out ?? { ok: true });
      } catch (e) {
        return fail(e);
      }
    };

  const project = (body: any, url: URL) => orch.get(body.project ?? url.searchParams.get("project") ?? "");

  const server = Bun.serve({
    port,
    development: development ? { hmr: true, console: true } : false,
    routes: {
      "/": index,

      "/api/settings": {
        GET: h(() => getSettings()),
        PUT: h((b) => updateSettings(b)),
      },

      "/api/projects/open": {
        POST: h((b) => orch.snapshot(orch.open(String(b.path ?? "")))),
      },
      "/api/project": {
        GET: h((_b, url) => orch.snapshot(project({}, url))),
      },

      "/api/fs": {
        GET: h((_b, url) => {
          const dir = resolve(url.searchParams.get("dir") || homedir());
          const dirs = readdirSync(dir)
            .filter((n) => !n.startsWith("."))
            .filter((n) => {
              try {
                return statSync(join(dir, n)).isDirectory();
              } catch {
                return false;
              }
            })
            .sort((a, b) => a.localeCompare(b));
          return { dir, parent: dirname(dir) === dir ? null : dirname(dir), dirs };
        }),
      },

      "/api/board": {
        PUT: h((b, url) => {
          const p = project(b, url);
          p.mutate((board) => {
            if (typeof b.name === "string" && b.name.trim()) board.name = b.name.trim();
            if (Array.isArray(b.columns)) {
              const userCols: Column[] = b.columns.map((c: any) => {
                const type: ColumnType = c.type === "skill" ? "skill" : "inert";
                const maxParallel = normalizeColumnParallel(type, c.maxParallel);
                const emoji = normalizeColumnEmoji(c.emoji);
                return {
                  ...unknownFields(c, COLUMN_KEYS),
                  id: typeof c.id === "string" && c.id ? c.id : newId("col"),
                  name: String(c.name || "Column").trim(),
                  type,
                  ...(type === "skill" && c.skill ? { skill: String(c.skill) } : {}),
                  ...(c.instructions?.trim() ? { instructions: String(c.instructions).trim() } : {}),
                  ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim() } : {}),
                  ...(maxParallel !== undefined ? { maxParallel } : {}),
                  ...(emoji !== undefined ? { emoji } : {}),
                };
              });
              if (userCols.filter((c) => !isDoneColumn(c)).length === 0) throw new Error("A board needs at least one column");
              const cols = ensureDoneColumn(userCols);
              const ids = new Set(cols.map((c) => c.id));
              const orphan = board.cards.find((c) => !ids.has(c.columnId));
              if (orphan) throw new Error(`Column still holds cards (e.g. "${orphan.title}"): move them first`);
              board.columns = cols;
            }
          });
          return orch.snapshot(p);
        }),
      },

      "/api/cards": {
        POST: h((b, url) => {
          const p = project(b, url);
          const now = new Date().toISOString();
          const columnId = b.columnId ?? p.board.columns[0]!.id;
          if (!p.column(columnId)) throw new Error("Unknown column");
          const id = newId("card");
          const number = p.mutate((board) => {
            const card: Card = {
              id,
              number: board.nextCardNumber,
              title: String(b.title || "Untitled").trim(),
              description: String(b.description ?? ""),
              columnId,
              createdAt: now,
              updatedAt: now,
              enteredColumnAt: now,
              history: [],
            };
            board.nextCardNumber += 1;
            p.addHistory(card, "created", `Created in ${p.column(columnId)!.name}`, columnId);
            board.cards.push(card);
            p.addQueued(card, board);
            return card.number;
          });
          return { id, number };
        }),
      },
      "/api/cards/:id": {
        PATCH: h((b, url, req) => {
          const p = project(b, url);
          p.mutate(() => {
            const card = p.card(req.params.id!);
            if (!card) throw new Error("Unknown card");
            if (typeof b.title === "string") card.title = b.title;
            if (typeof b.description === "string") card.description = b.description;
            card.updatedAt = new Date().toISOString();
            p.addHistory(card, "edited", "Edited by user");
          });
        }),
        DELETE: h((b, url, req) => {
          const p = project(b, url);
          p.mutate((board) => {
            board.cards = board.cards.filter((c) => c.id !== req.params.id);
          });
          removeScreenshots(req.params.id!);
        }),
      },
      "/api/cards/:id/move": {
        POST: h((b, url, req) => {
          const p = project(b, url);
          p.mutate((board) => p.moveCard(board, req.params.id!, String(b.columnId), b.index, "Moved by user"));
        }),
      },
      "/api/cards/:id/retry": {
        POST: h((b, url, req) => orch.retry(project(b, url), req.params.id!)),
      },
      "/api/cards/:id/answer": {
        POST: h((b, url, req) => orch.answer(project(b, url), req.params.id!, Array.isArray(b.answers) ? b.answers.map(String) : [])),
      },
      "/api/cards/:id/feedback": {
        POST: h((b, url, req) => orch.feedback(project(b, url), req.params.id!, typeof b.text === "string" ? b.text : "")),
      },
      "/api/cards/:id/screenshot": {
        GET: h((_b, url, req) => {
          const card = project({}, url).card(req.params.id!);
          if (!card) throw new Error("Unknown card");
          const file = resolveScreenshot(card.description, url.searchParams.get("file") ?? "", card.id);
          return new Response(Bun.file(file), { headers: { "content-type": "image/png" } });
        }),
      },
      "/api/cards/:id/resume": {
        POST: h((b, url, req) => orch.resumeSession(project(b, url), req.params.id!)),
      },
      "/api/cards/:id/test": {
        GET: h((b, url, req) => orch.testLog(project(b, url), req.params.id!)),
        PUT: h((b, url, req) => {
          const p = project(b, url);
          p.mutate(() => {
            const card = p.card(req.params.id!);
            if (!card) throw new Error("Unknown card");
            const command = String(b.command ?? "").trim();
            const testUrl = String(b.url ?? "").trim();
            if (command) card.test = { command, ...(testUrl ? { url: testUrl } : {}) };
            else delete card.test;
          });
        }),
      },
      "/api/cards/:id/test/start": {
        POST: h((b, url, req) => orch.startTest(project(b, url), req.params.id!)),
      },
      "/api/cards/:id/test/stop": {
        POST: h((b, url, req) => ({ stopped: orch.stopTest(project(b, url), req.params.id!) })),
      },
      "/api/cards/:id/cancel": {
        POST: h((b, url, req) => ({ cancelled: orch.cancel(project(b, url), req.params.id!) })),
      },
      "/api/cards/:id/log": {
        GET: h((b, url, req) => orch.getLog(project(b, url), req.params.id!)),
      },

      "/api/skills": {
        GET: h((b, url) => listSkills(project(b, url).path)),
        POST: h((b, url) => createSkill(project(b, url).path, String(b.name ?? ""), String(b.description ?? ""), String(b.body ?? ""))),
      },
      "/api/skill": {
        GET: h((b, url) => readSkill(project(b, url).path, url.searchParams.get("name") ?? "")),
        PUT: h((b, url) => saveSkill(project(b, url).path, String(b.name), String(b.content))),
      },

      "/ws": (req, srv) => (srv.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 })),
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "settings", settings: getSettings() } satisfies ServerEvent));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });

  return { server, orch };
}
