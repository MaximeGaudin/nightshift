import { useEffect, useRef, useState } from "react";
import type { LogLine, ProjectSnapshot, ServerEvent, Settings, SkillInfo } from "../shared/types.ts";

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body || method === "POST" || method === "PUT" || method === "PATCH" ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
  createCard: (project: string, columnId: string, title: string, description = "") =>
    call<{ id: string }>("POST", "/api/cards", { project, columnId, title, description }),
  updateCard: (project: string, id: string, patch: { title?: string; description?: string }) =>
    call("PATCH", `/api/cards/${id}`, { project, ...patch }),
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
  skills: (project: string) => call<SkillInfo[]>("GET", `/api/skills?${q(project)}`),
  skill: (project: string, name: string) =>
    call<SkillInfo & { content: string }>("GET", `/api/skill?${q(project)}&name=${encodeURIComponent(name)}`),
  saveSkill: (project: string, name: string, content: string) => call("PUT", "/api/skill", { project, name, content }),
  createSkill: (project: string, name: string, description: string, body: string) =>
    call<SkillInfo>("POST", "/api/skills", { project, name, description, body }),
};

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.onmessage = (m) => {
    const e = JSON.parse(m.data) as ServerEvent;
    for (const l of listeners) l(e);
  };
  socket.onclose = () => setTimeout(connect, 1000);
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

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => void api.settings().then(setSettings), []);
  useServerEvents((e) => e.type === "settings" && setSettings(e.settings));
  return settings;
}
