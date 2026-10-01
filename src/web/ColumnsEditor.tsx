import { useEffect, useState } from "react";
import type { Column, ProjectSnapshot, SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { ColumnIcon, Icon } from "./icons.tsx";
import { ErrorBanner, Modal } from "./ui.tsx";

/** Up/down chevron for the reorder buttons (icons.tsx has no arrow glyph). */
function Chevron({ up }: { up?: boolean }) {
  return (
    <svg
      className="icon"
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={up ? "M3.5 8.75L7 5.25l3.5 3.5" : "M3.5 5.25L7 8.75l3.5-3.5"} />
    </svg>
  );
}

type Draft = Column & { key: string };

export function ColumnsEditor({ snap, onClose }: { snap: ProjectSnapshot; onClose: () => void }) {
  const [name, setName] = useState(snap.board.name);
  const [cols, setCols] = useState<Draft[]>(snap.board.columns.map((c) => ({ ...c, key: c.id })));
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => void api.skills(snap.path).then(setSkills).catch((e) => setError(e.message)), []);

  const count = (id: string) => snap.board.cards.filter((c) => c.columnId === id).length;
  const patch = (i: number, p: Partial<Column>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, d: number) =>
    setCols((cs) => {
      const next = [...cs];
      const [c] = next.splice(i, 1);
      next.splice(i + d, 0, c!);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.saveBoard(snap.path, {
        name,
        columns: cols.map(({ key, ...c }) => c),
      });
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title="Colonnes du kanban"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={() =>
              setCols((cs) => [...cs, { id: "", key: crypto.randomUUID(), name: "Nouvelle colonne", type: "inert" }])
            }
          >
            <Icon name="plus" /> Colonne
          </button>
          <div className="spacer" />
          <button onClick={onClose}>Annuler</button>
          <button className="primary" disabled={saving} onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <label className="board-name">
        Nom du kanban
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="hint">
        Une colonne <strong>skill</strong> exécute le skill choisi sur chaque fiche qui y arrive (en parallèle, dans la limite des
        réglages). Le skill peut modifier la fiche puis l'envoyer à la colonne suivante.
      </p>
      <ol className="col-editor">
        {cols.map((c, i) => (
          <li key={c.key} className={c.type}>
            <div className="col-editor-row">
              <span className="order">{i + 1}</span>
              <ColumnIcon type={c.type} />
              <input aria-label="Nom" value={c.name} onChange={(e) => patch(i, { name: e.target.value })} />
              <select aria-label="Type" value={c.type} onChange={(e) => patch(i, { type: e.target.value as Column["type"] })}>
                <option value="inert">Inerte</option>
                <option value="skill">Skill</option>
              </select>
              {c.type === "skill" && (
                <select aria-label="Skill" value={c.skill ?? ""} onChange={(e) => patch(i, { skill: e.target.value })}>
                  <option value="">— choisir un skill —</option>
                  {c.skill && !skills.some((s) => s.name === c.skill) && <option value={c.skill}>{c.skill} (introuvable)</option>}
                  {(["project", "user"] as const).map((scope) => (
                    <optgroup key={scope} label={scope === "project" ? "Skills du projet" : "Skills utilisateur"}>
                      {skills
                        .filter((s) => s.scope === scope)
                        .map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              )}
              <div className="spacer" />
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                <Chevron up />
              </button>
              <button className="icon-btn" disabled={i === cols.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                <Chevron />
              </button>
              <button
                className="icon-btn danger"
                disabled={!!c.id && count(c.id) > 0}
                title={c.id && count(c.id) > 0 ? "Videz la colonne avant de la supprimer" : "Supprimer"}
                onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}
                aria-label="Supprimer"
              >
                <Icon name="trash" />
              </button>
            </div>
            {c.type === "skill" && (
              <>
                {c.skill && <p className="hint small">{skills.find((s) => s.name === c.skill)?.description}</p>}
                <textarea
                  className="instructions"
                  placeholder="Instructions additionnelles pour l'agent (optionnel)…"
                  value={c.instructions ?? ""}
                  onChange={(e) => patch(i, { instructions: e.target.value })}
                />
              </>
            )}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
