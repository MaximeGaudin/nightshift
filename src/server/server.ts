import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { describeModelChanges, diffModels, validateModelsStrict } from "../shared/models.ts";
import { normalizeSkipColumnIds, skippedColumns } from "../shared/skip.ts";
import {
  BACKLOG_COLUMN_ID,
  BACKLOG_COLUMN_NAME,
  type Card,
  type Column,
  type ColumnType,
  cardRef,
  ensureSystemColumns,
  isDoneColumn,
  normalizeColumnEmoji,
  normalizeColumnParallel,
  type ServerEvent,
} from "../shared/types.ts";
import { safeHttpUrl } from "../shared/urls.ts";
import index from "../web/index.html";
import { checkRequest, HttpError } from "./guard.ts";
import { Orchestrator } from "./orchestrator.ts";
import { removeScreenshots, resolveScreenshot } from "./screenshots.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { createSkill, listSkills, readSkill, saveSkill } from "./skills.ts";
import { BOARD_FILE, COLUMN_KEYS, isRaw, newId, type Project, type Raw, remapColumnId, unknownFields } from "./store.ts";

export function startServer({ port, development, agents = true }: { port: number; development?: boolean; agents?: boolean }) {
  // `bun --hot` re-runs this module on every change. Reuse the orchestrator from the previous run:
  // a new one would schedule every card a second time next to the old one, which keeps its watchers.
  const g = globalThis as { __nightshift?: { orch: Orchestrator; sockets: Set<ServerWebSocket<unknown>>; opened: Set<string> } };
  if (!g.__nightshift) {
    const orch = new Orchestrator({ agents });
    const sockets = new Set<ServerWebSocket<unknown>>();
    orch.on((e: ServerEvent) => {
      const msg = JSON.stringify(e);
      for (const ws of sockets) ws.send(msg);
    });
    g.__nightshift = { orch, sockets, opened: new Set() };
  }
  const { orch, sockets } = g.__nightshift;
  // Projects opened through POST /api/projects/open: the only ones other routes may address.
  if (!g.__nightshift.opened) g.__nightshift.opened = new Set();
  const opened = g.__nightshift.opened;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  /** HttpError keeps its status, any other Error is a bad request (400), anything else is a server fault (500). */
  const fail = (e: unknown) => {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Error) return json({ error: e.message }, 400);
    console.error("Unexpected error:", e);
    return json({ error: "Internal server error" }, 500);
  };

  /** Empty body is `{}`; anything else must be a JSON object. */
  const parseBody = (text: string): Raw => {
    if (!text.trim()) return {};
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON body");
    }
    if (!isRaw(data)) throw new Error("Body must be a JSON object");
    return data;
  };

  /** DELETE may carry a body with the project; a bad one is ignored (the query string still works). */
  const lenientBody = (text: string): Raw => {
    try {
      return parseBody(text);
    } catch {
      return {};
    }
  };

  /** Wraps a handler: parses the JSON body and turns thrown errors into 400s. */
  const h =
    (fn: (body: Raw, url: URL, req: Request & { params: Record<string, string> }) => unknown) =>
    async (req: Request & { params: Record<string, string> }) => {
      const denied = checkRequest(req, server.port as number);
      if (denied) return denied;
      try {
        const url = new URL(req.url);
        const body = req.method === "GET" ? {} : req.method === "DELETE" ? lenientBody(await req.text()) : parseBody(await req.text());
        const out = await fn(body, url, req);
        return out instanceof Response ? out : json(out ?? { ok: true });
      } catch (e) {
        return fail(e);
      }
    };

  /** Optional string field: undefined/null give undefined, any other non-string is a 400. */
  const optString = (b: Raw, key: string): string | undefined => {
    const v = b[key];
    if (v == null) return undefined;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    return v;
  };
  /** Optional skipColumnIds: undefined when absent, an error unless it is an array of strings. */
  const optSkipIds = (b: Raw): string[] | undefined => {
    const v = b.skipColumnIds;
    if (v == null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error("skipColumnIds must be an array of strings");
    return v;
  };
  const reqString = (b: Raw, key: string): string => {
    const v = optString(b, key);
    if (v === undefined) throw new Error(`${key} is required`);
    return v;
  };

  const project = (body: Raw, url: URL) => {
    const raw = body.project ?? url.searchParams.get("project");
    if (typeof raw !== "string" || !raw) throw new Error("Missing project");
    const path = resolve(raw);
    if (!opened.has(path)) throw new HttpError(404, "Unknown project");
    return orch.get(path);
  };

  /** Creates a card in a column (history entry, queueing) and returns it. */
  const createCard = (
    p: Project,
    {
      title,
      description,
      columnId,
      skipInput,
      historyText,
    }: { title?: string; description?: string; columnId?: string; skipInput?: string[]; historyText?: string },
  ): Card => {
    const now = new Date().toISOString();
    if (!columnId || !p.column(columnId)) throw new Error("Unknown column");
    const skipColumnIds = normalizeSkipColumnIds(p.board.columns, skipInput);
    return p.mutate((board) => {
      const card: Card = {
        id: newId("card"),
        number: board.nextCardNumber,
        title: (title || "Untitled").trim(),
        description: description ?? "",
        columnId,
        ...(skipColumnIds ? { skipColumnIds } : {}),
        createdAt: now,
        updatedAt: now,
        enteredColumnAt: now,
        history: [],
      };
      board.nextCardNumber += 1;
      p.addHistory(card, "created", historyText ?? `Created in ${p.column(columnId)?.name}`, columnId);
      board.cards.push(card);
      p.addQueued(card, board);
      return card;
    });
  };

  const server: Server<undefined> = Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: development ? { hmr: true, console: true } : false,
    routes: {
      "/": index,

      "/api/settings": {
        GET: h(() => getSettings()),
        PUT: h((b) => updateSettings(b)),
      },

      "/api/projects/open": {
        POST: h((b) => {
          const p = orch.open(String(b.path ?? ""));
          opened.add(p.path);
          const failed = orch.takeTemplateFailures(p.path);
          return failed.length > 0 ? { ...orch.snapshot(p), templateSkillsNotCopied: failed } : orch.snapshot(p);
        }),
      },
      "/api/project": {
        GET: h((_b, url) => orch.snapshot(project({}, url))),
      },

      "/api/fs": {
        GET: h((_b, url) => {
          const dir = resolve(url.searchParams.get("dir") || homedir());
          let entries: string[];
          try {
            entries = readdirSync(dir);
          } catch {
            throw new Error("Cannot read directory");
          }
          const dirs = entries
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
              const userCols: Column[] = b.columns.map((c: unknown, i: number) => {
                if (!isRaw(c)) throw new Error(`Column ${i + 1} must be an object`);
                const field = (key: string): string | undefined => {
                  const v = c[key];
                  if (v == null) return undefined;
                  if (typeof v !== "string") throw new Error(`Column ${i + 1}: ${key} must be a string`);
                  return v;
                };
                const id = field("id");
                const name = field("name");
                const skill = field("skill");
                const instructions = field("instructions")?.trim();
                const model = field("model")?.trim();
                const type: ColumnType = c.type === "skill" ? "skill" : "inert";
                const maxParallel = normalizeColumnParallel(type, c.maxParallel);
                const emoji = normalizeColumnEmoji(c.emoji);
                return {
                  ...unknownFields(c, COLUMN_KEYS),
                  id: id || newId("col"),
                  name: (name || "Column").trim(),
                  type,
                  ...(type === "skill" && skill ? { skill } : {}),
                  ...(instructions ? { instructions } : {}),
                  ...(model ? { model } : {}),
                  ...(type === "skill" && c.lockModel === true ? { lockModel: true as const } : {}),
                  ...(maxParallel !== undefined ? { maxParallel } : {}),
                  ...(emoji !== undefined ? { emoji } : {}),
                };
              });
              const seen = new Set<string>();
              for (const c of userCols) {
                if (seen.has(c.id)) throw new Error(`Duplicate column id "${c.id}"`);
                seen.add(c.id);
              }
              if (userCols.filter((c) => !isDoneColumn(c)).length === 0) throw new Error("A board needs at least one column");
              const { columns: cols, renamedFrom } = ensureSystemColumns(userCols);
              if (renamedFrom !== undefined) for (const card of board.cards) remapColumnId(card, renamedFrom, BACKLOG_COLUMN_ID);
              const ids = new Set(cols.map((c) => c.id));
              const orphan = board.cards.find((c) => !ids.has(c.columnId));
              if (orphan) throw new Error(`Column still holds cards (e.g. "${orphan.title}"): move them first`);
              board.columns = cols;
              for (const card of board.cards) {
                const skip = normalizeSkipColumnIds(cols, card.skipColumnIds);
                if (skip) card.skipColumnIds = skip;
                else delete card.skipColumnIds;
              }
            }
          });
          return orch.snapshot(p);
        }),
      },

      "/api/cards": {
        POST: h((b, url) => {
          const p = project(b, url);
          const card = createCard(p, {
            title: optString(b, "title"),
            description: optString(b, "description"),
            columnId: optString(b, "columnId") ?? p.board.columns[0]?.id,
            skipInput: optSkipIds(b),
          });
          return { id: card.id, number: card.number };
        }),
      },
      "/api/backlog": {
        POST: h((b) => {
          const raw = b.project;
          if (typeof raw !== "string" || !raw) throw new Error("project is required");
          if (!isAbsolute(raw)) throw new Error("project must be an absolute path");
          const title = reqString(b, "title").trim();
          if (!title) throw new Error("title must not be empty");
          const description = optString(b, "description") ?? "";
          const skipInput = optSkipIds(b);
          const source = optString(b, "source")?.trim() ?? "";
          if (source.length > 100) throw new Error("source must be at most 100 characters");
          const path = resolve(raw);
          let p: Project;
          if (opened.has(path)) p = orch.get(path);
          else if (existsSync(join(path, BOARD_FILE))) {
            p = orch.open(path);
            opened.add(p.path);
          } else throw new HttpError(404, "Unknown project");
          const card = createCard(p, {
            title,
            description,
            columnId: BACKLOG_COLUMN_ID,
            skipInput,
            historyText: source ? `Created in ${BACKLOG_COLUMN_NAME} by ${source}` : `Created in ${BACKLOG_COLUMN_NAME}`,
          });
          return json({ id: card.id, number: card.number, ref: cardRef(card) }, 201);
        }),
      },
      "/api/cards/:id": {
        PATCH: h((b, url, req) => {
          const p = project(b, url);
          const title = optString(b, "title");
          const description = optString(b, "description");
          const skipInput = optSkipIds(b);
          const hasModels = b.models !== undefined;
          const modelsCheck = validateModelsStrict(b.models);
          if (!modelsCheck.ok) throw new Error(modelsCheck.error);
          p.mutate((board) => {
            const card = p.card(req.params.id);
            if (!card) throw new HttpError(404, "Unknown card");
            if (title !== undefined) card.title = title;
            if (description !== undefined) card.description = description;
            card.updatedAt = new Date().toISOString();
            if (title !== undefined || description !== undefined || (skipInput === undefined && !hasModels))
              p.addHistory(card, "edited", "Edited by user");
            if (hasModels) {
              const changes = diffModels(card.models, modelsCheck.models);
              if (modelsCheck.models) card.models = modelsCheck.models;
              else delete card.models;
              if (changes.length > 0) p.addHistory(card, "edited", describeModelChanges(changes, "user"));
            }
            if (skipInput !== undefined) {
              const skip = normalizeSkipColumnIds(board.columns, skipInput);
              const before = (card.skipColumnIds ?? []).join("\n");
              if ((skip ?? []).join("\n") !== before) {
                if (skip) card.skipColumnIds = skip;
                else delete card.skipColumnIds;
                const names = skippedColumns(board.columns, card).map((c) => c.name);
                p.addHistory(card, "edited", names.length > 0 ? `Skipped columns: ${names.join(", ")}` : "Skipped columns cleared");
              }
            }
          });
        }),
        DELETE: h((b, url, req) => {
          const p = project(b, url);
          p.mutate((board) => {
            board.cards = board.cards.filter((c) => c.id !== req.params.id);
          });
          removeScreenshots(req.params.id);
          orch.purgeCard(p, req.params.id);
        }),
      },
      "/api/cards/:id/move": {
        POST: h((b, url, req) => {
          const p = project(b, url);
          const columnId = reqString(b, "columnId");
          const index = b.index ?? undefined;
          if (index !== undefined && !Number.isInteger(index)) throw new Error("index must be an integer");
          p.mutate((board) => p.moveCard(board, req.params.id, columnId, index as number | undefined, "Moved by user"));
        }),
      },
      "/api/sequence/play": {
        POST: h((b, url) => {
          const p = project(b, url);
          orch.sequence.play(p);
          return { sequence: orch.sequence.get(p) };
        }),
      },
      "/api/sequence/pause": {
        POST: h((b, url) => {
          const p = project(b, url);
          orch.sequence.pause(p);
          return { sequence: orch.sequence.get(p) };
        }),
      },
      "/api/cards/:id/retry": {
        POST: h((b, url, req) => orch.retry(project(b, url), req.params.id)),
      },
      "/api/cards/:id/answer": {
        POST: h((b, url, req) => orch.answer(project(b, url), req.params.id, Array.isArray(b.answers) ? b.answers.map(String) : [])),
      },
      "/api/cards/:id/feedback": {
        POST: h((b, url, req) => orch.feedback(project(b, url), req.params.id, typeof b.text === "string" ? b.text : "")),
      },
      "/api/cards/:id/screenshot": {
        GET: h((_b, url, req) => {
          const card = project({}, url).card(req.params.id);
          if (!card) throw new HttpError(404, "Unknown card");
          const file = resolveScreenshot(card.description, url.searchParams.get("file") ?? "", card.id);
          return new Response(Bun.file(file), { headers: { "content-type": "image/png" } });
        }),
      },
      "/api/cards/:id/resume": {
        POST: h((b, url, req) => orch.resumeSession(project(b, url), req.params.id)),
      },
      "/api/cards/:id/test": {
        GET: h((b, url, req) => orch.testLog(project(b, url), req.params.id)),
        PUT: h((b, url, req) => {
          const p = project(b, url);
          const command = (optString(b, "command") ?? "").trim();
          const rawUrl = (optString(b, "url") ?? "").trim();
          p.mutate(() => {
            const card = p.card(req.params.id);
            if (!card) throw new HttpError(404, "Unknown card");
            const testUrl = rawUrl ? safeHttpUrl(rawUrl) : "";
            if (testUrl === null) throw new Error("url must be an absolute http(s) URL");
            if (command) card.test = { command, ...(testUrl ? { url: testUrl } : {}) };
            else delete card.test;
          });
        }),
      },
      "/api/cards/:id/test/start": {
        POST: h((b, url, req) => orch.startTest(project(b, url), req.params.id)),
      },
      "/api/cards/:id/test/stop": {
        POST: h((b, url, req) => ({ stopped: orch.stopTest(project(b, url), req.params.id) })),
      },
      "/api/cards/:id/cancel": {
        POST: h((b, url, req) => ({ cancelled: orch.cancel(project(b, url), req.params.id) })),
      },
      "/api/cards/:id/log": {
        GET: h((b, url, req) => orch.getLog(project(b, url), req.params.id)),
      },

      "/api/favorite-skills": {
        PUT: h((b, url) => {
          const p = project(b, url);
          const name = reqString(b, "name").trim();
          if (typeof b.favorite !== "boolean") throw new Error("favorite must be a boolean");
          const known = new Set(listSkills(p.path).map((s) => s.name));
          if (b.favorite && !known.has(name)) throw new HttpError(404, `Skill not found: ${name}`);
          p.mutate((board) => {
            // Favorites of skills that no longer exist are dropped on every toggle.
            const next = new Set((board.favoriteSkills ?? []).filter((n) => known.has(n)));
            if (b.favorite) next.add(name);
            else next.delete(name);
            if (next.size > 0) board.favoriteSkills = [...next].sort((x, y) => x.localeCompare(y));
            else delete board.favoriteSkills;
          });
          return orch.snapshot(p);
        }),
      },
      "/api/quick-runs": {
        POST: h((b, url) => {
          const p = project(b, url);
          return { id: orch.queueQuickRun(p, reqString(b, "skill"), optString(b, "instruction") ?? "") };
        }),
      },
      "/api/quick-runs/:id/cancel": {
        POST: h((b, url, req) => ({ ok: orch.cancelQuickRun(project(b, url), req.params.id) })),
      },

      "/api/skills": {
        GET: h((b, url) => listSkills(project(b, url).path)),
        POST: h((b, url) =>
          createSkill(project(b, url).path, reqString(b, "name"), optString(b, "description") ?? "", optString(b, "body") ?? ""),
        ),
      },
      "/api/skill": {
        GET: h((b, url) => readSkill(project(b, url).path, url.searchParams.get("name") ?? "")),
        PUT: h((b, url) => saveSkill(project(b, url).path, reqString(b, "name"), reqString(b, "content"))),
      },

      "/ws": (req, srv) =>
        checkRequest(req, server.port as number) ?? (srv.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 })),
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
