import { useEffect, useRef, useState } from "react";
import type { SequenceState } from "../shared/sequence.ts";
import type { LogLine, ProjectSnapshot, ServerEvent, Settings, SkillInfo } from "../shared/types.ts";

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body || method === "POST" || method === "PUT" || method === "PATCH" ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: { error?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

const q = (project: string) => `project=${encodeURIComponent(project)}`;

export const api = {
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (s: Partial<Settings>) => call<Settings>("PUT", "/api/settings", s),
  open: (path: string) => call<ProjectSnapshot>("POST", "/api/projects/open", { path }),
  fs: (dir?: string) =>
    call<{ dir: string; parent: string | null; dirs: string[] }>("GET", `/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  saveBoard: (project: string, patch: object) => call<ProjectSnapshot>("PUT", "/api/board", { project, ...patch }),
  createCard: (project: string, columnId: string, title: string, description = "", skipColumnIds?: string[], dependsOn?: string[]) =>
    call<{ id: string }>("POST", "/api/cards", {
      project,
      columnId,
      title,
      description,
      ...(skipColumnIds && skipColumnIds.length > 0 ? { skipColumnIds } : {}),
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    }),
  updateCard: (
    project: string,
    id: string,
    patch: {
      title?: string;
      description?: string;
      skipColumnIds?: string[];
      dependsOn?: string[];
      models?: Record<string, string> | null;
    },
  ) => call("PATCH", `/api/cards/${id}`, { project, ...patch }),
  deleteCard: (project: string, id: string) => call("DELETE", `/api/cards/${id}?${q(project)}`),
  moveCard: (project: string, id: string, columnId: string, index?: number) =>
    call("POST", `/api/cards/${id}/move`, { project, columnId, index }),
  resumeSession: (project: string, id: string) => call("POST", `/api/cards/${id}/resume`, { project }),
  retry: (project: string, id: string) => call("POST", `/api/cards/${id}/retry`, { project }),
  answer: (project: string, id: string, answers: string[]) => call("POST", `/api/cards/${id}/answer`, { project, answers }),
  sendFeedback: (project: string, id: string, text: string) => call("POST", `/api/cards/${id}/feedback`, { project, text }),
  testLog: (project: string, id: string) => call<LogLine[]>("GET", `/api/cards/${id}/test?${q(project)}`),
  setTest: (project: string, id: string, command: string, url: string) => call("PUT", `/api/cards/${id}/test`, { project, command, url }),
  startTest: (project: string, id: string) => call("POST", `/api/cards/${id}/test/start`, { project }),
  stopTest: (project: string, id: string) => call("POST", `/api/cards/${id}/test/stop`, { project }),
  cancel: (project: string, id: string) => call("POST", `/api/cards/${id}/cancel`, { project }),
  log: (project: string, id: string) => call<LogLine[]>("GET", `/api/cards/${id}/log?${q(project)}`),
  sequencePlay: (project: string) => call<{ sequence: SequenceState }>("POST", "/api/sequence/play", { project }),
  sequencePause: (project: string) => call<{ sequence: SequenceState }>("POST", "/api/sequence/pause", { project }),
  skills: (project: string) => call<SkillInfo[]>("GET", `/api/skills?${q(project)}`),
  skill: (project: string, name: string) =>
    call<SkillInfo & { content: string }>("GET", `/api/skill?${q(project)}&name=${encodeURIComponent(name)}`),
  saveSkill: (project: string, name: string, content: string) => call("PUT", "/api/skill", { project, name, content }),
  createSkill: (project: string, name: string, description: string, body: string) =>
    call<SkillInfo>("POST", "/api/skills", { project, name, description, body }),
  toggleFavoriteSkill: (project: string, name: string, favorite: boolean) =>
    call<ProjectSnapshot>("PUT", "/api/favorite-skills", { project, name, favorite }),
  startQuickRun: (project: string, skill: string, instruction: string) =>
    call<{ id: string }>("POST", "/api/quick-runs", { project, skill, instruction }),
  cancelQuickRun: (project: string, id: string) => call<{ ok: boolean }>("POST", `/api/quick-runs/${id}/cancel`, { project }),
};

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let failures = 0;

/** Reconnection delay: 1 s after the first failure, doubling up to 30 s. */
export function reconnectDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failureCount - 1), 30_000);
}

/** Decodes a WebSocket message; anything that is not a JSON object with a `type` is dropped (null). */
export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  try {
    const e = JSON.parse(data);
    return typeof e === "object" && e !== null && typeof e.type === "string" ? (e as ServerEvent) : null;
  } catch {
    return null;
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    failures = 0;
  };
  ws.onmessage = (m) => {
    const e = parseServerEvent(m.data);
    if (e) for (const l of listeners) l(e);
  };
  ws.onclose = () => {
    failures += 1;
    setTimeout(connect, reconnectDelay(failures));
  };
}

export function useServerEvents(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!socket) connect();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/** Loads the settings and follows their changes. A failed first load is reported through `onError` instead of being left unhandled. */
export function useSettings(onError?: (message: string) => void) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((e: unknown) => errorRef.current?.(e instanceof Error ? e.message : String(e)));
  }, []);
  useServerEvents((e) => e.type === "settings" && setSettings(e.settings));
  return settings;
}
