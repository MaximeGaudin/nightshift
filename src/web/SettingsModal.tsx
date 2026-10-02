import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type LanguageSetting, MAX_PARALLEL, type Settings, WORKTREE_POLICIES, type WorktreePolicy } from "../shared/types.ts";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
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
      <div className="mt-2 divide-y rounded-md border bg-card">{children}</div>
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

/** Settings form; rendered separately from the dialog so it can be tested without a browser. */
export function SettingsContent({
  value,
  onChange,
  currentProject,
  onOpenProject,
  worktreePolicy,
  onWorktreePolicyChange,
}: {
  value: Settings;
  onChange: (s: Settings) => void;
  currentProject?: string;
  onOpenProject?: (path: string) => void;
  /** Policy of the open project; the "This project" section only shows when a project is open and a policy is given. */
  worktreePolicy?: WorktreePolicy;
  onWorktreePolicyChange?: (policy: WorktreePolicy) => void;
}) {
  const s = value;
  const { t } = useT();
  const languages = languageOptions();
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
        <Row id="set-max-parallel" label={t("settings.maxParallel.label")} help={t("settings.maxParallel.help")}>
          <Input
            id="set-max-parallel"
            type="number"
            min={1}
            max={MAX_PARALLEL}
            value={s.maxParallel}
            onChange={(e) => onChange({ ...s, maxParallel: Number(e.target.value) })}
          />
        </Row>
        <Row id="set-sound" label={t("settings.sound.label")} help={t("settings.sound.help")}>
          <Switch id="set-sound" checked={s.soundNotifications} onCheckedChange={(v) => onChange({ ...s, soundNotifications: v })} />
        </Row>
      </Section>

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
        <Row id="set-model" label={t("settings.model.label")} help={t("settings.model.help")}>
          <Input
            id="set-model"
            value={s.model}
            placeholder={t("settings.model.placeholder")}
            onChange={(e) => onChange({ ...s, model: e.target.value })}
          />
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
      </Section>

      {currentProject && worktreePolicy && (
        <Section title={t("settings.project.title")} description={t("settings.project.description")}>
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
        </Section>
      )}

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
                {path === currentProject && <Badge variant="secondary">{t("settings.recent.current")}</Badge>}
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

const EDITABLE = ["maxParallel", "claudePath", "permissionMode", "model", "extraArgs", "soundNotifications", "language"] as const;

/** True when the form differs from the saved settings on any editable field. */
export function settingsDirty(saved: Settings, draft: Settings): boolean {
  return EDITABLE.some((k) => saved[k] !== draft[k]);
}

export function SettingsModal({
  settings,
  onClose,
  currentProject,
  onOpenProject,
  worktreePolicy,
}: {
  settings: Settings;
  onClose: () => void;
  /** Path of the open project (marked in the recent list) and the action to open another one. */
  currentProject?: string;
  onOpenProject?: (path: string) => void;
  /** Saved worktree policy of the open project. */
  worktreePolicy?: WorktreePolicy;
}) {
  const { t } = useT();
  const [s, setS] = useState(settings);
  const [policy, setPolicy] = useState(worktreePolicy);
  const policyDirty = !!currentProject && policy !== undefined && policy !== worktreePolicy;
  const save = () =>
    api
      .saveSettings({
        maxParallel: s.maxParallel,
        claudePath: s.claudePath,
        permissionMode: s.permissionMode,
        model: s.model,
        extraArgs: s.extraArgs,
        soundNotifications: s.soundNotifications,
        language: s.language,
      })
      .then(() => (policyDirty && currentProject && policy ? api.setWorktreePolicy(currentProject, policy) : undefined))
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
        worktreePolicy={policy}
        onWorktreePolicyChange={setPolicy}
        onOpenProject={
          onOpenProject &&
          ((path) => {
            if ((settingsDirty(settings, s) || policyDirty) && !confirm(t("settings.discardChanges"))) return;
            onClose();
            onOpenProject(path);
          })
        }
      />
    </AppDialog>
  );
}
