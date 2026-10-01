import { useCallback, useEffect, useState } from "react";
import type { SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { ErrorBanner, Modal } from "./ui.tsx";

const TEMPLATE = `Tu reçois une fiche de kanban (titre + description).

1. Lis la fiche.
2. Fais le travail demandé.
3. Mets à jour la description avec le résultat.
4. Envoie la fiche à la colonne suivante.`;

export function SkillsModal({ project, onClose }: { project: string; onClose: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: TEMPLATE });

  const reload = useCallback(
    () =>
      api
        .skills(project)
        .then(setSkills)
        .catch((e) => setError(e.message)),
    [project],
  );
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    if (!selected) return;
    api
      .skill(project, selected)
      .then((s) => {
        setContent(s.content);
        setOriginal(s.content);
      })
      .catch((e) => setError(e.message));
  }, [project, selected]);

  const current = skills.find((s) => s.name === selected);
  const dirty = content !== original;
  const shown = skills.filter((s) => (s.name + s.description).toLowerCase().includes(filter.toLowerCase()));

  const pick = (name: string | null, create = false) => {
    if (dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    setCreating(create);
    setSelected(name);
    if (!name) {
      setContent("");
      setOriginal("");
    }
  };

  const save = async () => {
    try {
      if (creating) {
        const s = await api.createSkill(project, form.name.trim(), form.description, form.body);
        await reload();
        setCreating(false);
        setSelected(s.name);
        setForm({ name: "", description: "", body: TEMPLATE });
      } else if (selected) {
        await api.saveSkill(project, selected, content);
        setOriginal(content);
        reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      wide
      title="Skills"
      onClose={() => {
        if (!dirty || confirm("Abandonner les modifications non enregistrées ?")) onClose();
      }}
      footer={
        <>
          <button type="button" onClick={() => pick(null, true)}>
            <Icon name="plus" /> Nouveau skill (projet)
          </button>
          <div className="spacer" />
          {(creating || selected) && (
            <button type="button" className="primary" disabled={creating ? !form.name.trim() : !dirty} onClick={save}>
              {creating ? "Créer" : "Enregistrer"}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="skills">
        <div className="skill-list">
          <input placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul>
            {shown.map((s) => (
              <li key={s.name}>
                <button type="button" className={s.name === selected && !creating ? "active" : ""} onClick={() => pick(s.name)}>
                  <span className="skill-name">
                    <Icon name="bolt" />
                    <span className="truncate">{s.name}</span>
                    <span className={`scope ${s.scope}`}>{s.scope === "project" ? "projet" : "user"}</span>
                  </span>
                  <span className="skill-desc">{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="skill-editor">
          {creating ? (
            <>
              <p className="hint">
                Le skill sera créé dans <code>.claude/skills/&lt;nom&gt;/SKILL.md</code> du projet (commitable).
              </p>
              <label>
                Nom (minuscules, chiffres, tirets)
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ex. write-spec" />
              </label>
              <label>
                Description (quand l'utiliser)
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label className="grow">
                Instructions
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
              </label>
            </>
          ) : current ? (
            <>
              <p className="hint small">
                <code>{current.path}</code>
                {current.scope === "user" && " · skill utilisateur, partagé par tous vos projets"}
              </p>
              <textarea className="grow code" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            </>
          ) : (
            <p className="muted empty">Choisissez un skill à éditer, ou créez-en un nouveau.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
