import { useState } from "react";
import type { SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { notifyError } from "./notify.ts";

export const SKILL_TEMPLATE = `Tu reçois une fiche de kanban (titre + description).

1. Lis la fiche.
2. Fais le travail demandé.
3. Mets à jour la description avec le résultat.
4. Envoie la fiche à la colonne suivante.`;

/** Dedicated dialog (stacked over the Skills modal) that creates a project skill. */
export function CreateSkillDialog({
  project,
  onCreated,
  onClose,
}: {
  project: string;
  onCreated: (skill: SkillInfo) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ name: "", description: "", body: SKILL_TEMPLATE });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const skill = await api.createSkill(project, form.name.trim(), form.description, form.body);
      onCreated(skill);
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <AppDialog
      size="md"
      title="Nouveau skill"
      description={
        <>
          Le skill sera créé dans <code>.claude/skills/&lt;nom&gt;/SKILL.md</code> du projet (commitable).
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button type="button" disabled={busy || !form.name.trim()} onClick={create}>
            Créer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && form.name.trim()) void create();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-name">Nom (minuscules, chiffres, tirets)</Label>
          <Input
            id="skill-name"
            autoFocus
            value={form.name}
            placeholder="ex. write-spec"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-description">Description (quand l'utiliser)</Label>
          <Input id="skill-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-body">Instructions</Label>
          <Textarea
            id="skill-body"
            className="min-h-[220px] font-mono text-xs"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </div>
      </form>
    </AppDialog>
  );
}
