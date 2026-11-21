// Settings > This project > Issue sources: list, add, edit, remove, test and sync the project's issue sources.
// Changes are saved at once (not with the dialog's Save button). Provider choices come only from PROVIDERS.

import { useState } from "react";
import {
  effectiveBaseUrl,
  type IssueSource,
  type IssueSourceInput,
  type IssueSourceStatus,
  normalizeLabels,
  normalizeQuery,
  PROVIDERS,
  providerInfo,
  providerLabel,
  QUERY_MAX_LENGTH,
} from "../shared/issues.ts";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { useT } from "./i18n/index.ts";
import { ProviderIcon } from "./icons.tsx";
import { notifyError, notifySyncResults } from "./notify.ts";
import { ResyncPreviewDialog } from "./ResyncPreviewDialog.tsx";
import { timeAgo } from "./ui.tsx";

/** Form state of a source being added or edited. `labels` is the comma separated text; `token` is write-only. */
export interface SourceDraft {
  id?: string;
  provider: string;
  baseUrl: string;
  repo: string;
  labels: string;
  query: string;
  enabled: boolean;
  token: string;
}

export function emptyDraft(): SourceDraft {
  return { provider: PROVIDERS[0]?.id ?? "", baseUrl: "", repo: "", labels: "", query: "", enabled: true, token: "" };
}

/** New source form pre-filled from the project's git remote (whatever the detect route found). */
export function draftFromDetect(detected: { provider?: string; baseUrl?: string; repo?: string }): SourceDraft {
  const d = emptyDraft();
  const info = detected.provider ? providerInfo(detected.provider) : undefined;
  if (!info) return d;
  // The provider default base URL is left empty: it is the placeholder and the server's fallback.
  const baseUrl = detected.baseUrl && detected.baseUrl !== info.defaultBaseUrl ? detected.baseUrl : "";
  return { ...d, provider: info.id, baseUrl, repo: detected.repo ?? "" };
}

export function draftFromSource(s: IssueSource): SourceDraft {
  const info = providerInfo(s.provider);
  return {
    id: s.id,
    provider: s.provider,
    baseUrl: info?.defaultBaseUrl === s.baseUrl ? "" : s.baseUrl,
    repo: s.repo,
    labels: (s.labels ?? []).join(", "),
    query: s.query ?? "",
    enabled: s.enabled,
    token: "",
  };
}

export const toInput = (s: IssueSource): IssueSourceInput => ({
  id: s.id,
  provider: s.provider,
  baseUrl: s.baseUrl,
  repo: s.repo,
  ...(s.labels ? { labels: s.labels } : {}),
  ...(s.query ? { query: s.query } : {}),
  enabled: s.enabled,
});

export function draftToInput(d: SourceDraft): IssueSourceInput {
  const labels = d.labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    ...(d.id ? { id: d.id } : {}),
    provider: d.provider,
    ...(d.baseUrl.trim() ? { baseUrl: d.baseUrl.trim() } : {}),
    repo: d.repo.trim(),
    ...(labels.length > 0 ? { labels } : {}),
    ...(d.query.trim() && providerInfo(d.provider)?.supportsQuery ? { query: d.query.trim() } : {}),
    enabled: d.enabled,
  };
}

/** Base URL the token belongs to: the typed one, else the provider default. */
const tokenBaseUrl = (d: Pick<SourceDraft, "provider" | "baseUrl">) => d.baseUrl.trim() || providerInfo(d.provider)?.defaultBaseUrl || "";

type Client = Pick<typeof api, "saveIssueSources" | "saveIssueToken">;

/** Labels as the server stores them, compared case-insensitively and in any order. */
const labelKey = (labels: string[] | undefined) => JSON.stringify((normalizeLabels(labels) ?? []).map((l) => l.toLowerCase()).sort());

/**
 * True when saving `input` over the existing source `old` changes what the source imports: its target (provider,
 * base URL, repo), labels or query. Differences that only come from normalization (label order or case, blank query,
 * trailing slash, empty base URL meaning the provider default) do not count. False for a new source.
 */
export function resyncChanged(old: IssueSource | undefined, input: IssueSourceInput): boolean {
  if (!old) return false;
  const info = providerInfo(input.provider);
  const baseUrl = info ? effectiveBaseUrl(info, input.baseUrl) : input.baseUrl;
  const query = info?.supportsQuery ? normalizeQuery(input.query) : undefined;
  return (
    old.provider !== input.provider ||
    old.baseUrl !== baseUrl ||
    old.repo !== input.repo.trim() ||
    labelKey(old.labels) !== labelKey(input.labels) ||
    (old.query ?? "") !== (query ?? "")
  );
}

/** Runs a manual sync (`prune`: resync) and shows one toast per source with its outcome. Returns whether it ran. */
export async function syncAndNotify(
  client: Pick<typeof api, "syncIssues" | "resyncIssues">,
  project: string,
  sources: Pick<IssueSource, "id" | "repo">[],
  { sourceId, prune = false }: { sourceId?: string; prune?: boolean } = {},
): Promise<void> {
  const answer = prune && sourceId ? await client.resyncIssues(project, sourceId) : await client.syncIssues(project, sourceId);
  notifySyncResults(answer.results ?? [], sources);
}

/**
 * Saves a draft: its token first (only when one was typed, so an empty field never clears the saved token), then the
 * whole source list with the draft replacing its source (or appended when new).
 */
export async function saveDraft(client: Client, project: string, sources: IssueSource[], draft: SourceDraft) {
  if (draft.token.trim()) await client.saveIssueToken(draft.provider, tokenBaseUrl(draft), draft.token.trim());
  const input = draftToInput(draft);
  const list = sources.map((s) => (s.id === draft.id ? input : toInput(s)));
  if (!draft.id) list.push(input);
  return client.saveIssueSources(project, list);
}

export function removeSource(client: Client, project: string, sources: IssueSource[], id: string) {
  return client.saveIssueSources(project, sources.filter((s) => s.id !== id).map(toInput));
}

export function IssueSourcesEditor({
  project,
  sources,
  status,
  canSync,
  initialDraft,
}: {
  project: string;
  sources: IssueSource[];
  status?: Record<string, IssueSourceStatus>;
  /** False on an instance that does not run this project's agents: Sync now is disabled. */
  canSync: boolean;
  /** Form open at first render (tests). */
  initialDraft?: SourceDraft;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<SourceDraft | null>(initialDraft ?? null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** Source whose resync preview dialog is open; `afterSave` when it was offered after changing the filters. */
  const [resyncTarget, setResyncTarget] = useState<{ sourceId: string; repo: string; afterSave: boolean } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startAdd = () =>
    run(async () => {
      setTestResult(null);
      const detected = await api.detectIssueSource(project).catch(() => ({}));
      setDraft(draftFromDetect(detected));
    });

  const save = () =>
    draft &&
    run(async () => {
      await saveDraft(api, project, sources, draft);
      setDraft(null);
      setTestResult(null);
      const old = draft.id ? sources.find((s) => s.id === draft.id) : undefined;
      // Changed filters or target: offer to drop the Backlog cards that no longer match (else the normal sync runs).
      if (old && canSync && draft.enabled && resyncChanged(old, draftToInput(draft))) {
        setResyncTarget({ sourceId: old.id, repo: draft.repo.trim(), afterSave: true });
      }
    });

  const test = () =>
    draft &&
    run(async () => {
      try {
        const { count } = await api.testIssueSource(project, draftToInput(draft), draft.token.trim() || undefined);
        setTestResult({ ok: true, text: t("settings.issues.testOk", { count: String(count) }) });
      } catch (e) {
        setTestResult({ ok: false, text: (e as Error).message });
      }
    });

  const toggle = (s: IssueSource, enabled: boolean) =>
    run(() =>
      api.saveIssueSources(
        project,
        sources.map((x) => (x.id === s.id ? { ...toInput(x), enabled } : toInput(x))),
      ),
    );

  const editing = draft ? providerInfo(draft.provider) : undefined;
  const editedStatus = draft?.id ? status?.[draft.id] : undefined;

  return (
    <div className="issue-sources flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label>{t("settings.issues.label")}</Label>
          <p className="text-xs text-muted-foreground">{t("settings.issues.help")}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {sources.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSync || busy}
              onClick={() => run(() => syncAndNotify(api, project, sources))}
            >
              {t("settings.issues.syncAll")}
            </Button>
          )}
          {!draft && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={startAdd} className="issue-source-add">
              {t("settings.issues.add")}
            </Button>
          )}
        </div>
      </div>

      {sources.length === 0 && !draft && <p className="issue-sources-empty text-xs text-muted-foreground">{t("settings.issues.empty")}</p>}

      <ul className="flex flex-col gap-1.5">
        {sources.map((s) => {
          const st = status?.[s.id];
          return (
            <li key={s.id} className="issue-source-row flex flex-col gap-1 rounded-md border bg-background px-2.5 py-2">
              <div className="flex items-center gap-2">
                <ProviderIcon provider={s.provider} size={14} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`${providerLabel(s.provider)} · ${s.baseUrl}`}>
                  {s.repo}
                </span>
                <Switch
                  checked={s.enabled}
                  disabled={busy}
                  aria-label={t("settings.issues.enabled")}
                  onCheckedChange={(v) => toggle(s, v)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!canSync || busy || !s.enabled}
                  onClick={() => run(() => syncAndNotify(api, project, sources, { sourceId: s.id }))}
                >
                  {st?.syncing ? t("settings.issues.syncing") : t("settings.issues.sync")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="issue-source-resync"
                  disabled={!canSync || busy || !s.enabled}
                  onClick={() => setResyncTarget({ sourceId: s.id, repo: s.repo, afterSave: false })}
                >
                  {t("settings.issues.resync")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setTestResult(null);
                    setDraft(draftFromSource(s));
                  }}
                >
                  {t("settings.issues.edit")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    confirm(t("settings.issues.removeConfirm", { repo: s.repo })) && run(() => removeSource(api, project, sources, s.id))
                  }
                >
                  {t("settings.issues.remove")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                {s.labels && <span>{t("settings.issues.labelsShort", { labels: s.labels.join(", ") })}</span>}
                {s.query && (
                  <span className="issue-source-query" title={s.query}>
                    {t("settings.issues.queryShort", { query: s.query.length > 60 ? `${s.query.slice(0, 60)}…` : s.query })}
                  </span>
                )}
                {st?.lastSyncAt && (
                  <span className="issue-source-synced">{t("settings.issues.lastSync", { when: timeAgo(st.lastSyncAt) })}</span>
                )}
                {st && !st.hasToken && <span className="issue-source-no-token">{t("settings.issues.noToken")}</span>}
              </div>
              {st?.lastError && (
                <p className="issue-source-error text-[11px] text-destructive">
                  {t("settings.issues.lastError", { error: st.lastError, when: st.lastErrorAt ? timeAgo(st.lastErrorAt) : "" })}
                </p>
              )}
              {st?.writeBackError && (
                <p className="issue-source-writeback-error text-[11px] text-destructive">
                  {t("settings.issues.writeBackError", { error: st.writeBackError })}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {draft && editing && (
        <div className="issue-source-form flex flex-col gap-2 rounded-md border bg-background p-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-provider">{t("settings.issues.provider")}</Label>
              <Select value={draft.provider} onValueChange={(v) => setDraft({ ...draft, provider: v })}>
                <SelectTrigger id="issue-provider" className="w-full">
                  <SelectValue>{editing.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-repo">{t("settings.issues.repo")}</Label>
              <Input
                id="issue-repo"
                value={draft.repo}
                placeholder="owner/name"
                onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-base">
                {t("settings.issues.baseUrl")}
                {editing.baseUrlRequired ? " *" : ""}
              </Label>
              <Input
                id="issue-base"
                value={draft.baseUrl}
                placeholder={editing.baseUrlHint}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-labels">{t("settings.issues.labels")}</Label>
              <Input
                id="issue-labels"
                value={draft.labels}
                placeholder={t("settings.issues.labelsPlaceholder")}
                onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
              />
            </div>
            {editing.supportsQuery && (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="issue-query">{t("settings.issues.query")}</Label>
                <Input
                  id="issue-query"
                  value={draft.query}
                  maxLength={QUERY_MAX_LENGTH}
                  placeholder={t("settings.issues.queryPlaceholder")}
                  onChange={(e) => setDraft({ ...draft, query: e.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">{t("settings.issues.queryHelp")}</p>
              </div>
            )}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="issue-token">{t("settings.issues.token")}</Label>
              <div className="flex gap-1.5">
                <Input
                  id="issue-token"
                  type="password"
                  autoComplete="off"
                  value={draft.token}
                  placeholder={editedStatus?.hasToken ? t("settings.issues.tokenSaved") : t("settings.issues.tokenPlaceholder")}
                  onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                />
                {editedStatus?.hasToken && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => run(() => api.saveIssueToken(draft.provider, tokenBaseUrl(draft), ""))}
                  >
                    {t("settings.issues.tokenRemove")}
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("settings.issues.tokenHelp")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="issue-enabled" checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
            <Label htmlFor="issue-enabled">{t("settings.issues.enabled")}</Label>
          </div>
          {testResult && (
            <p className={`issue-source-test text-xs ${testResult.ok ? "text-muted-foreground" : "text-destructive"}`}>{testResult.text}</p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={test}>
              {t("settings.issues.test")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setTestResult(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={save}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
      {resyncTarget && (
        <ResyncPreviewDialog
          project={project}
          sourceId={resyncTarget.sourceId}
          repo={resyncTarget.repo}
          description={resyncTarget.afterSave ? t("settings.issues.resyncAfterSave") : undefined}
          onClose={() => setResyncTarget(null)}
          onConfirm={() => {
            const target = resyncTarget;
            setResyncTarget(null);
            void run(() => syncAndNotify(api, project, sources, { sourceId: target.sourceId, prune: true }));
          }}
        />
      )}
    </div>
  );
}
