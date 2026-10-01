import { useState } from "react";
import type { SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { t, useT } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";

/** Starting instructions of a new skill, in the active language. */
export const skillTemplate = () => t("skills.create.template");

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
  const { t } = useT();
  const [form, setForm] = useState(() => ({ name: "", description: "", body: skillTemplate() }));
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
      title={t("skills.create.title")}
      description={
        <>
          {t("skills.create.descriptionBefore")} <code>.claude/skills/&lt;{t("skills.create.nameToken")}&gt;/SKILL.md</code>{" "}
          {t("skills.create.descriptionAfter")}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy || !form.name.trim()} onClick={create}>
            {t("skills.create.submit")}
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
          <Label htmlFor="skill-name">{t("skills.create.nameLabel")}</Label>
          <Input
            id="skill-name"
            autoFocus
            value={form.name}
            placeholder={t("skills.create.namePlaceholder")}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-description">{t("skills.create.descriptionLabel")}</Label>
          <Input id="skill-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-body">{t("skills.create.bodyLabel")}</Label>
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
