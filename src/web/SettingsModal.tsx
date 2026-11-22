import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EFFORT_LEVELS } from "../shared/effort.ts";
import type { IssueSource, IssueSourceStatus } from "../shared/issues.ts";
import {
  MERGE_METHODS,
  type MergeMethod,
  PULL_REQUESTS_SETTINGS,
  type PullRequestSettings,
  type PullRequestsSetting,
} from "../shared/pullRequests.ts";
import { type LanguageSetting, MAX_PARALLEL, type Settings, WORKTREE_POLICIES, type WorktreePolicy } from "../shared/types.ts";
import { AgentFeaturesFields, inheritedFeatures } from "./AgentFeaturesFields.tsx";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { IssueSourcesEditor } from "./IssueSourcesEditor.tsx";
import { type MessageKey, t, useT } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";

const PERMISSION_OPTIONS: { value: Settings["permissionMode"]; label: MessageKey }[] = [
  { value: "auto", label: "settings.permission.auto" },
  { value: "acceptEdits", label: "settings.permission.acceptEdits" },
  { value: "dontAsk", label: "settings.permission.dontAsk" },
  { value: "bypassPermissions", label: "settings.permission.bypassPermissions" },
  { value: "plan", label: "settings.permission.plan" },
];

/** Language choices; the language names stay in their own language, only "Auto" is translated. */
export function languageOptions(): { value: LanguageSetting; label: string }[] {
  return [
    { value: "auto", label: t("settings.language.auto") },
    { value: "en", label: "English" },
    { value: "fr", label: "Français" },
  ];
}

const PULL_REQUEST_LABELS: Record<PullRequestsSetting, MessageKey> = {
  auto: "settings.pullRequests.auto",
  off: "settings.pullRequests.off",
};

const MERGE_METHOD_LABELS: Record<MergeMethod, MessageKey> = {
  merge: "settings.mergeMethod.merge",
  squash: "settings.mergeMethod.squash",
  rebase: "settings.mergeMethod.rebase",
};

const samePr = (a?: PullRequestSettings, b?: PullRequestSettings) =>
  a?.pullRequests === b?.pullRequests && a?.mergeMethod === b?.mergeMethod && a?.autoMerge === b?.autoMerge;

const WORKTREE_LABELS: Record<WorktreePolicy, MessageKey> = {
  required: "settings.worktree.required",
  auto: "settings.worktree.auto",
  forbidden: "settings.worktree.forbidden",
};

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-section flex flex-col gap-1">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-2 divide-y rounded-lg border bg-lane">{children}</div>
    </section>
  );
}

/** Form row: label and help on the left, control on the right. */
function Row({ id, label, help, children }: { id?: string; label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Live issue sources of the open project, passed from its snapshot. */
export interface IssuesProps {
  sources: IssueSource[];
  status?: Record<string, IssueSourceStatus>;
  canSync: boolean;
}

/** Settings form; rendered separately from the dialog so it can be tested without a browser. */
export function SettingsContent({
  value,
  onChange,
  currentProject,
  onOpenProject,
  projectMaxParallel,
  onProjectMaxParallelChange,
  worktreePolicy,
  onWorktreePolicyChange,
  pullRequests,
  onPullRequestsChange,
  issues,
}: {
  value: Settings;
  onChange: (s: Settings) => void;
  currentProject?: string;
  onOpenProject?: (path: string) => void;
  /** Agent cap of the open project (draft value); the "This project" section shows only with a project. */
  projectMaxParallel?: number;
  onProjectMaxParallelChange?: (n: number) => void;
  /** Worktree policy of the open project (draft value); its row shows in the "This project" section when given. */
  worktreePolicy?: WorktreePolicy;
  onWorktreePolicyChange?: (policy: WorktreePolicy) => void;
  /** Pull request settings of the open project (draft value); their rows show in "This project" when given. */
  pullRequests?: PullRequestSettings;
  onPullRequestsChange?: (pr: PullRequestSettings) => void;
  /** Issue sources of the open project, live from its snapshot; the editor saves on its own. */
  issues?: IssuesProps;
}) {
  const s = value;
  const { t } = useT();
  const languages = languageOptions();
  // With smart mode on, the global features and effort are only the fallback.
  const withSmartFallback = (help: string) => (s.smartMode !== false ? `${help} ${t("settings.smart.fallback")}` : help);
  return (
    <div className="flex flex-col gap-6">
      <Section title={t("settings.interface.title")} description={t("settings.interface.description")}>
        <Row id="set-language" label={t("settings.language.label")} help={t("settings.language.help")}>
          <Select value={s.language} onValueChange={(v) => onChange({ ...s, language: v as LanguageSetting })}>
            <SelectTrigger id="set-language" className="w-full">
              <SelectValue>{languages.find((o) => o.value === s.language)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {languages.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title={t("settings.agents.title")} description={t("settings.agents.description")}>
        <Row id="set-cpu" label={t("settings.cpu.label")} help={t("settings.cpu.help")}>
          <Switch id="set-cpu" checked={s.cpuThrottleEnabled} onCheckedChange={(v) => onChange({ ...s, cpuThrottleEnabled: v })} />
        </Row>
        <Row id="set-cpu-limit" label={t("settings.cpuLimit.label")} help={t("settings.cpuLimit.help")}>
          <Input
            id="set-cpu-limit"
            type="number"
            min={10}
            max={100}
            disabled={!s.cpuThrottleEnabled}
            value={s.cpuThrottleMaxPercent}
            onChange={(e) => onChange({ ...s, cpuThrottleMaxPercent: Number(e.target.value) })}
          />
        </Row>
        <Row id="set-sound" label={t("settings.sound.label")} help={t("settings.sound.help")}>
          <Switch id="set-sound" checked={s.soundNotifications} onCheckedChange={(v) => onChange({ ...s, soundNotifications: v })} />
        </Row>
      </Section>

      {currentProject && projectMaxParallel !== undefined && (
        <Section title={t("settings.project.title")} description={t("settings.project.description", { path: currentProject })}>
          <Row id="set-project-parallel" label={t("settings.projectParallel.label")} help={t("settings.projectParallel.help")}>
            <Input
              id="set-project-parallel"
              type="number"
              min={1}
              max={MAX_PARALLEL}
              value={projectMaxParallel}
              onChange={(e) => onProjectMaxParallelChange?.(Number(e.target.value))}
            />
          </Row>
          {worktreePolicy && (
            <Row id="set-worktree" label={t("settings.worktree.label")} help={t("settings.worktree.help")}>
              <Select value={worktreePolicy} onValueChange={(v) => onWorktreePolicyChange?.(v as WorktreePolicy)}>
                <SelectTrigger id="set-worktree" className="w-full">
                  <SelectValue>{t(WORKTREE_LABELS[worktreePolicy])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WORKTREE_POLICIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(WORKTREE_LABELS[p])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
          {pullRequests && (
            <>
              <Row id="set-pull-requests" label={t("settings.pullRequests.label")} help={t("settings.pullRequests.help")}>
                <Select
                  value={pullRequests.pullRequests}
                  onValueChange={(v) => onPullRequestsChange?.({ ...pullRequests, pullRequests: v as PullRequestsSetting })}
                >
                  <SelectTrigger id="set-pull-requests" className="w-full">
                    <SelectValue>{t(PULL_REQUEST_LABELS[pullRequests.pullRequests])}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {PULL_REQUESTS_SETTINGS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(PULL_REQUEST_LABELS[v])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              {pullRequests.pullRequests !== "off" && (
                <>
                  <Row id="set-merge-method" label={t("settings.mergeMethod.label")} help={t("settings.mergeMethod.help")}>
                    <Select
                      value={pullRequests.mergeMethod}
                      onValueChange={(v) => onPullRequestsChange?.({ ...pullRequests, mergeMethod: v as MergeMethod })}
                    >
                      <SelectTrigger id="set-merge-method" className="w-full">
                        <SelectValue>{t(MERGE_METHOD_LABELS[pullRequests.mergeMethod])}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {MERGE_METHODS.map((v) => (
                          <SelectItem key={v} value={v}>
                            {t(MERGE_METHOD_LABELS[v])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Row>
                  <Row id="set-auto-merge" label={t("settings.autoMerge.label")} help={t("settings.autoMerge.help")}>
                    <Switch
                      id="set-auto-merge"
                      checked={pullRequests.autoMerge}
                      onCheckedChange={(v) => onPullRequestsChange?.({ ...pullRequests, autoMerge: v })}
                    />
                  </Row>
                </>
              )}
            </>
          )}
          {issues && (
            <IssueSourcesEditor project={currentProject} sources={issues.sources} status={issues.status} canSync={issues.canSync} />
          )}
        </Section>
      )}

      <Section title={t("settings.claude.title")} description={t("settings.claude.description")}>
        <Row id="set-permission" label={t("settings.permission.label")} help={t("settings.permission.help")}>
          <div className="flex flex-col gap-2">
            <Select value={s.permissionMode} onValueChange={(v) => onChange({ ...s, permissionMode: v as Settings["permissionMode"] })}>
              <SelectTrigger id="set-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {t(o.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {s.permissionMode === "bypassPermissions" && (
              <Alert variant="warn">
                <TriangleAlert />
                <div>{t("settings.permission.bypassWarning")}</div>
              </Alert>
            )}
          </div>
        </Row>
        <Row id="set-carry-tokens" label={t("settings.carryTokens.label")} help={t("settings.carryTokens.help")}>
          <Input
            id="set-carry-tokens"
            type="number"
            min={0}
            step={1000}
            value={s.carryMaxTokens}
            onChange={(e) => onChange({ ...s, carryMaxTokens: Math.max(0, Math.trunc(Number(e.target.value)) || 0) })}
          />
        </Row>
        <Row id="set-carry-age" label={t("settings.carryAge.label")} help={t("settings.carryAge.help")}>
          <Input
            id="set-carry-age"
            type="number"
            min={1}
            value={s.carryMaxAgeMinutes}
            onChange={(e) => onChange({ ...s, carryMaxAgeMinutes: Math.max(1, Math.trunc(Number(e.target.value)) || 1) })}
          />
        </Row>
        <Row id="set-model" label={t("settings.model.label")} help={t("settings.model.help")}>
          <Input
            id="set-model"
            value={s.model}
            placeholder={t("settings.model.placeholder")}
            onChange={(e) => onChange({ ...s, model: e.target.value })}
          />
        </Row>
        <Row id="set-smart-mode" label={t("settings.smart.label")} help={t("settings.smart.help")}>
          <Switch id="set-smart-mode" checked={s.smartMode !== false} onCheckedChange={(v) => onChange({ ...s, smartMode: v })} />
        </Row>
        <Row id="set-agent-features" label={t("agentFeatures.title")} help={withSmartFallback(t("agentFeatures.help"))}>
          <AgentFeaturesFields
            idPrefix="set-agent-features"
            value={s.agentFeatures}
            inherited={inheritedFeatures({})}
            onChange={(next) => onChange({ ...s, agentFeatures: next ?? {} })}
          />
        </Row>
        <Row id="set-effort" label={t("settings.effort.label")} help={withSmartFallback(t("settings.effort.help"))}>
          <select
            id="set-effort"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={s.effort}
            onChange={(e) => onChange({ ...s, effort: e.target.value as Settings["effort"] })}
          >
            <option value="">{t("settings.effort.economic")}</option>
            <option value="inherit">{t("settings.effort.inherit")}</option>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        <Row id="set-claude-path" label={t("settings.claudePath.label")}>
          <Input id="set-claude-path" value={s.claudePath} onChange={(e) => onChange({ ...s, claudePath: e.target.value })} />
        </Row>
        <Row id="set-extra-args" label={t("settings.extraArgs.label")}>
          <Input
            id="set-extra-args"
            value={s.extraArgs}
            placeholder={t("settings.extraArgs.placeholder")}
            onChange={(e) => onChange({ ...s, extraArgs: e.target.value })}
          />
        </Row>
        <Row id="set-teamclaude" label={t("settings.teamclaude.label")} help={t("settings.teamclaude.help")}>
          <Switch id="set-teamclaude" checked={s.teamclaudeEnabled} onCheckedChange={(v) => onChange({ ...s, teamclaudeEnabled: v })} />
        </Row>
        <Row id="set-teamclaude-url" label={t("settings.teamclaudeUrl.label")} help={t("settings.teamclaudeUrl.help")}>
          <Input
            id="set-teamclaude-url"
            value={s.teamclaudeUrl}
            placeholder="http://localhost:3456"
            onChange={(e) => onChange({ ...s, teamclaudeUrl: e.target.value })}
          />
        </Row>
      </Section>

      <Section title={t("settings.recent.title")} description={t("settings.recent.description")}>
        {s.recentProjects.length === 0 ? (
          <p className="recent-empty px-3 py-4 text-center text-xs text-muted-foreground">{t("settings.recent.empty")}</p>
        ) : (
          <ul>
            {s.recentProjects.map((path) => (
              <li key={path} className="recent-project flex items-center gap-2 px-3 py-2 not-first:border-t">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                  {path}
                </span>
                {path === currentProject && (
                  <Badge variant="secondary" dot="primary">
                    {t("settings.recent.current")}
                  </Badge>
                )}
                <Button type="button" size="sm" variant="outline" disabled={path === currentProject} onClick={() => onOpenProject?.(path)}>
                  {t("settings.recent.open")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-xs text-muted-foreground">{t("settings.footnote")}</p>
    </div>
  );
}

const EDITABLE = [
  "claudePath",
  "permissionMode",
  "model",
  "effort",
  "extraArgs",
  "soundNotifications",
  "smartMode",
  "language",
  "carryMaxTokens",
  "carryMaxAgeMinutes",
  "teamclaudeEnabled",
  "teamclaudeUrl",
  "cpuThrottleEnabled",
  "cpuThrottleMaxPercent",
] as const;

/** True when the form differs from the saved settings on any editable field, or the project cap changed. */
export function settingsDirty(
  saved: Settings,
  draft: Settings,
  savedCap?: number,
  draftCap?: number,
  savedPolicy?: WorktreePolicy,
  draftPolicy?: WorktreePolicy,
  savedPr?: PullRequestSettings,
  draftPr?: PullRequestSettings,
): boolean {
  return (
    !samePr(savedPr, draftPr) ||
    EDITABLE.some((k) => saved[k] !== draft[k]) ||
    JSON.stringify(saved.agentFeatures ?? {}) !== JSON.stringify(draft.agentFeatures ?? {}) ||
    savedCap !== draftCap ||
    savedPolicy !== draftPolicy
  );
}

/**
 * Saves the global settings, then the open project's cap and worktree policy into its nightshift.json, each only
 * when it changed. Rejects on the first failed write.
 */
export async function saveSettingsAndProject(
  client: Pick<typeof api, "saveSettings" | "saveBoard"> & Partial<Pick<typeof api, "setWorktreePolicy" | "setPullRequests">>,
  draft: Settings,
  project?: {
    path: string;
    saved: number;
    draft: number;
    policy?: { saved: WorktreePolicy; draft: WorktreePolicy };
    pr?: { saved: PullRequestSettings; draft: PullRequestSettings };
  },
): Promise<void> {
  await client.saveSettings({
    ...(Object.fromEntries(EDITABLE.map((k) => [k, draft[k]])) as Partial<Settings>),
    agentFeatures: draft.agentFeatures ?? {},
  });
  if (!project) return;
  if (project.draft !== project.saved) await client.saveBoard(project.path, { maxParallel: project.draft });
  if (project.policy && project.policy.draft !== project.policy.saved) await client.setWorktreePolicy?.(project.path, project.policy.draft);
  if (project.pr && !samePr(project.pr.saved, project.pr.draft)) await client.setPullRequests?.(project.path, project.pr.draft);
}

export function SettingsModal({
  settings,
  onClose,
  currentProject,
  onOpenProject,
  projectMaxParallel,
  worktreePolicy,
  pullRequests,
  issues,
}: {
  settings: Settings;
  onClose: () => void;
  /** Path of the open project (marked in the recent list) and the action to open another one. */
  currentProject?: string;
  onOpenProject?: (path: string) => void;
  /** Effective agent cap of the open project, from its snapshot. */
  projectMaxParallel?: number;
  /** Saved worktree policy of the open project. */
  worktreePolicy?: WorktreePolicy;
  /** Saved pull request settings of the open project. */
  pullRequests?: PullRequestSettings;
  issues?: IssuesProps;
}) {
  const { t } = useT();
  const [s, setS] = useState(settings);
  const [cap, setCap] = useState(projectMaxParallel);
  const [policy, setPolicy] = useState(worktreePolicy);
  const [pr, setPr] = useState(pullRequests);
  const project =
    currentProject && projectMaxParallel !== undefined && cap !== undefined
      ? {
          path: currentProject,
          saved: projectMaxParallel,
          draft: cap,
          ...(worktreePolicy && policy ? { policy: { saved: worktreePolicy, draft: policy } } : {}),
          ...(pullRequests && pr ? { pr: { saved: pullRequests, draft: pr } } : {}),
        }
      : undefined;
  // On a failed write the dialog stays open with the draft.
  const save = () =>
    saveSettingsAndProject(api, s, project)
      .then(onClose)
      .catch((e) => notifyError(e.message));

  return (
    <AppDialog
      size="lg"
      title={t("settings.title")}
      description={t("settings.description")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <SettingsContent
        value={s}
        onChange={setS}
        currentProject={currentProject}
        projectMaxParallel={cap}
        onProjectMaxParallelChange={setCap}
        worktreePolicy={policy}
        onWorktreePolicyChange={setPolicy}
        pullRequests={pr}
        onPullRequestsChange={setPr}
        issues={issues}
        onOpenProject={
          onOpenProject &&
          ((path) => {
            if (
              settingsDirty(settings, s, projectMaxParallel, cap, worktreePolicy, policy, pullRequests, pr) &&
              !confirm(t("settings.discardChanges"))
            )
              return;
            onClose();
            onOpenProject(path);
          })
        }
      />
    </AppDialog>
  );
}
