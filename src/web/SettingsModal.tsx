import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MAX_PARALLEL, type Settings } from "../shared/types.ts";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { notifyError } from "./notify.ts";

const PERMISSION_OPTIONS: { value: Settings["permissionMode"]; label: string }[] = [
  { value: "auto", label: "auto — un classifieur autorise ou refuse chaque action (recommandé)" },
  { value: "acceptEdits", label: "acceptEdits — édite les fichiers, refuse les commandes non autorisées" },
  { value: "dontAsk", label: "dontAsk — refuse tout ce qui n'est pas pré-autorisé" },
  { value: "bypassPermissions", label: "bypassPermissions — tout autorisé (risqué)" },
  { value: "plan", label: "plan — lecture seule" },
];

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
}: {
  value: Settings;
  onChange: (s: Settings) => void;
  currentProject?: string;
  onOpenProject?: (path: string) => void;
}) {
  const s = value;
  return (
    <div className="flex flex-col gap-6">
      <Section title="Agents" description="Combien d'agents peuvent tourner en même temps, et comment vous êtes prévenu.">
        <Row
          id="set-max-parallel"
          label="Plafond global d'agents en parallèle"
          help="Tous projets confondus. La limite se règle par colonne ; ce plafond empêche seulement d'en lancer trop au total."
        >
          <Input
            id="set-max-parallel"
            type="number"
            min={1}
            max={MAX_PARALLEL}
            value={s.maxParallel}
            onChange={(e) => onChange({ ...s, maxParallel: Number(e.target.value) })}
          />
        </Row>
        <Row
          id="set-sound"
          label="Sons de notification"
          help="Joue un son quand une carte a besoin de vous (colonne inerte, question, erreur). Le navigateur exige un premier clic sur la page."
        >
          <Switch id="set-sound" checked={s.soundNotifications} onCheckedChange={(v) => onChange({ ...s, soundNotifications: v })} />
        </Row>
      </Section>

      <Section title="Claude" description="Comment Claude Code est lancé pour chaque carte.">
        <Row
          id="set-permission"
          label="Mode de permission de Claude Code"
          help="Contrôle ce que les agents ont le droit de faire sans confirmation."
        >
          <div className="flex flex-col gap-2">
            <Select value={s.permissionMode} onValueChange={(v) => onChange({ ...s, permissionMode: v as Settings["permissionMode"] })}>
              <SelectTrigger id="set-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {s.permissionMode === "bypassPermissions" && (
              <Alert variant="warn">
                <TriangleAlert />
                <div>Les agents pourront exécuter n'importe quelle commande dans le dossier du projet sans confirmation.</div>
              </Alert>
            )}
          </div>
        </Row>
        <Row id="set-model" label="Modèle par défaut" help="S'applique aux colonnes sans modèle propre. Vide = défaut du CLI claude.">
          <Input
            id="set-model"
            value={s.model}
            placeholder="ex. sonnet, opus"
            onChange={(e) => onChange({ ...s, model: e.target.value })}
          />
        </Row>
        <Row id="set-claude-path" label="Commande claude">
          <Input id="set-claude-path" value={s.claudePath} onChange={(e) => onChange({ ...s, claudePath: e.target.value })} />
        </Row>
        <Row id="set-extra-args" label="Arguments supplémentaires">
          <Input
            id="set-extra-args"
            value={s.extraArgs}
            placeholder={'ex. --allowedTools "Bash(git *)" --max-budget-usd 2'}
            onChange={(e) => onChange({ ...s, extraArgs: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="Projets récents" description="Projets ouverts récemment. Ouvrir l'un d'eux remplace le tableau affiché.">
        {s.recentProjects.length === 0 ? (
          <p className="recent-empty px-3 py-4 text-center text-xs text-muted-foreground">Aucun projet récent pour le moment.</p>
        ) : (
          <ul>
            {s.recentProjects.map((path) => (
              <li key={path} className="recent-project flex items-center gap-2 px-3 py-2 not-first:border-t">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                  {path}
                </span>
                {path === currentProject && <Badge variant="secondary">Projet courant</Badge>}
                <Button type="button" size="sm" variant="outline" disabled={path === currentProject} onClick={() => onOpenProject?.(path)}>
                  Ouvrir
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-xs text-muted-foreground">Réglages globaux, stockés dans ~/.nightshift/settings.json.</p>
    </div>
  );
}

const DISCARD = "Abandonner les modifications non enregistrées ?";

const EDITABLE = ["maxParallel", "claudePath", "permissionMode", "model", "extraArgs", "soundNotifications"] as const;

/** True when the form differs from the saved settings on any editable field. */
export function settingsDirty(saved: Settings, draft: Settings): boolean {
  return EDITABLE.some((k) => saved[k] !== draft[k]);
}

export function SettingsModal({
  settings,
  onClose,
  currentProject,
  onOpenProject,
}: {
  settings: Settings;
  onClose: () => void;
  /** Path of the open project (marked in the recent list) and the action to open another one. */
  currentProject?: string;
  onOpenProject?: (path: string) => void;
}) {
  const [s, setS] = useState(settings);
  const save = () =>
    api
      .saveSettings({
        maxParallel: s.maxParallel,
        claudePath: s.claudePath,
        permissionMode: s.permissionMode,
        model: s.model,
        extraArgs: s.extraArgs,
        soundNotifications: s.soundNotifications,
      })
      .then(onClose)
      .catch((e) => notifyError(e.message));

  return (
    <AppDialog
      size="lg"
      title="Réglages"
      description="Préférences globales, communes à tous vos projets."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button type="button" onClick={save}>
            Enregistrer
          </Button>
        </>
      }
    >
      <SettingsContent
        value={s}
        onChange={setS}
        currentProject={currentProject}
        onOpenProject={
          onOpenProject &&
          ((path) => {
            if (settingsDirty(settings, s) && !confirm(DISCARD)) return;
            onClose();
            onOpenProject(path);
          })
        }
      />
    </AppDialog>
  );
}
