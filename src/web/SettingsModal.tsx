import { useState } from "react";
import type { Settings } from "../shared/types.ts";
import { api } from "./api.ts";
import { ErrorBanner, Modal } from "./ui.tsx";

export function SettingsModal({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [s, setS] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    api
      .saveSettings({
        maxParallel: s.maxParallel,
        claudePath: s.claudePath,
        permissionMode: s.permissionMode,
        model: s.model,
        extraArgs: s.extraArgs,
      })
      .then(onClose)
      .catch((e) => setError(e.message));

  return (
    <Modal
      title="Réglages"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="form settings">
        <label>
          Agents en parallèle (tous projets confondus)
          <input
            type="number"
            min={1}
            max={32}
            value={s.maxParallel}
            onChange={(e) => setS({ ...s, maxParallel: Number(e.target.value) })}
          />
        </label>
        <label>
          Mode de permission de Claude Code
          <select value={s.permissionMode} onChange={(e) => setS({ ...s, permissionMode: e.target.value as Settings["permissionMode"] })}>
            <option value="auto">auto — un classifieur autorise ou refuse chaque action (recommandé)</option>
            <option value="acceptEdits">acceptEdits — édite les fichiers, refuse les commandes non autorisées</option>
            <option value="dontAsk">dontAsk — refuse tout ce qui n'est pas pré-autorisé</option>
            <option value="bypassPermissions">bypassPermissions — tout autorisé (risqué)</option>
            <option value="plan">plan — lecture seule</option>
          </select>
        </label>
        {s.permissionMode === "bypassPermissions" && (
          <p className="hint warn">
            Les agents pourront exécuter n'importe quelle commande dans le dossier du projet sans confirmation.
          </p>
        )}
        <label>
          Modèle (vide = défaut de Claude Code)
          <input value={s.model} placeholder="ex. sonnet, opus" onChange={(e) => setS({ ...s, model: e.target.value })} />
        </label>
        <label>
          Commande claude
          <input value={s.claudePath} onChange={(e) => setS({ ...s, claudePath: e.target.value })} />
        </label>
        <label>
          Arguments supplémentaires
          <input
            value={s.extraArgs}
            placeholder={'ex. --allowedTools "Bash(git *)" --max-budget-usd 2'}
            onChange={(e) => setS({ ...s, extraArgs: e.target.value })}
          />
        </label>
        <p className="hint small settings-note">Réglages globaux, stockés dans ~/.nightshift/settings.json.</p>
      </div>
    </Modal>
  );
}
