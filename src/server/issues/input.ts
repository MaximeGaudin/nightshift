// Validation of the issue sources sent by the client, and their merge into the board.

import { effectiveBaseUrl, type IssueSource, normalizeLabels, providerInfo, validRepo } from "../../shared/issues.ts";
import type { Board } from "../../shared/types.ts";
import { isRaw, newId } from "../store.ts";

/** A source as typed by the user, checked: every field but the id and the imported ids. */
export type CheckedSource = Omit<IssueSource, "id" | "importedIds"> & { id?: string };

/** Checks one source input; throws an Error (HTTP 400) naming the bad field. */
export function checkSourceInput(raw: unknown): CheckedSource {
  if (!isRaw(raw)) throw new Error("source must be an object");
  const provider = typeof raw.provider === "string" ? raw.provider : "";
  const info = providerInfo(provider);
  if (!info) throw new Error(`Unknown issue provider: ${provider || "(none)"}`);
  if (raw.baseUrl != null && typeof raw.baseUrl !== "string") throw new Error("baseUrl must be a string");
  const rawBase = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const baseUrl = effectiveBaseUrl(info, rawBase || undefined);
  if (!baseUrl) throw new Error(rawBase ? "baseUrl must be an http(s) URL" : `baseUrl is required for ${info.label}`);
  const repo = typeof raw.repo === "string" ? raw.repo.trim().replace(/\.git$/, "") : "";
  if (!validRepo(repo)) throw new Error("repo must look like owner/name");
  if (raw.labels != null && (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== "string")))
    throw new Error("labels must be an array of strings");
  if (raw.enabled != null && typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (raw.id != null && typeof raw.id !== "string") throw new Error("id must be a string");
  const labels = normalizeLabels(raw.labels);
  return {
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    provider: info.id,
    baseUrl,
    repo,
    ...(labels ? { labels } : {}),
    enabled: raw.enabled !== false,
  };
}

/**
 * Replaces the board's sources with the checked inputs. An input with a known id keeps its imported ids unless its
 * provider, base URL or repo changed. Returns the ids of the sources added or changed (to sync now).
 */
export function replaceSources(board: Board, inputs: CheckedSource[]): string[] {
  const before = new Map((board.issueSources ?? []).map((s) => [s.id, s]));
  const changed: string[] = [];
  const seen = new Set<string>();
  const next: IssueSource[] = inputs.map((input) => {
    const old = input.id && !seen.has(input.id) ? before.get(input.id) : undefined;
    const id = old ? old.id : newId("src");
    seen.add(id);
    const sameTarget = old && old.provider === input.provider && old.baseUrl === input.baseUrl && old.repo === input.repo;
    const src: IssueSource = {
      id,
      provider: input.provider,
      baseUrl: input.baseUrl,
      repo: input.repo,
      ...(input.labels ? { labels: input.labels } : {}),
      enabled: input.enabled,
      importedIds: sameTarget ? old.importedIds : [],
    };
    if (!old || JSON.stringify(old) !== JSON.stringify(src)) changed.push(id);
    return src;
  });
  if (next.length > 0) board.issueSources = next;
  else delete board.issueSources;
  return changed;
}
