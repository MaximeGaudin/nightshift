import { useEffect, useState } from "react";
import { type Column, ensureDoneColumn, isDoneColumn, MAX_PARALLEL, type ProjectSnapshot, type SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { ColumnGlyph, Icon } from "./icons.tsx";
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

const EMOJI_TITLE = "Emoji optionnel — tapez ou collez-en un (macOS : Ctrl+Cmd+Espace). Vide = icône de type.";

function EmojiInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  return (
    <input
      className="col-emoji-input"
      aria-label="Emoji"
      placeholder="·"
      title={EMOJI_TITLE}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

type Draft = Column & { key: string };

/** Empty input → undefined (column default); otherwise an integer clamped to 1–MAX_PARALLEL. */
function clampParallel(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_PARALLEL, Math.max(1, n));
}

export function ColumnsEditor({ snap, onClose }: { snap: ProjectSnapshot; onClose: () => void }) {
  const [name, setName] = useState(snap.board.name);
  const [cols, setCols] = useState<Draft[]>(() => ensureDoneColumn(snap.board.columns).map((c) => ({ ...c, key: c.id })));
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      void api
        .skills(snap.path)
        .then(setSkills)
        .catch((e) => setError(e.message)),
    [snap.path],
  );

  const count = (id: string) => snap.board.cards.filter((c) => c.columnId === id).length;
  const patch = (i: number, p: Partial<Column>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, d: number) =>
    setCols((cs) => {
      const target = i + d;
      if (isDoneColumn(cs[i]) || target < 0 || target >= cs.length - 1) return cs;
      const next = [...cs];
      const [c] = next.splice(i, 1);
      next.splice(i + d, 0, c);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            type="button"
            onClick={() =>
              setCols((cs) => [
                ...cs.slice(0, -1),
                { id: "", key: crypto.randomUUID(), name: "Nouvelle colonne", type: "inert" },
                cs[cs.length - 1],
              ])
            }
          >
            <Icon name="plus" /> Colonne
          </button>
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="primary" disabled={saving} onClick={save}>
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
        Une colonne <strong>skill</strong> exécute le skill choisi sur chaque fiche qui y arrive. Chaque colonne skill a sa propre limite
        d'agents en parallèle (1 par défaut), sous le plafond global des réglages. Le skill peut modifier la fiche puis l'envoyer à la
        colonne suivante. Le champ emoji (optionnel) remplace l'icône de type de la colonne.
      </p>
      <ol className="col-editor">
        {cols.map((c, i) =>
          isDoneColumn(c) ? (
            <li key={c.key} className="locked">
              <div className="col-editor-row">
                <span className="order">{i + 1}</span>
                <Icon name="lock" />
                <EmojiInput value={c.emoji} onChange={(v) => patch(i, { emoji: v })} />
                <span className="locked-name">Done</span>
                <span className="locked-label">Colonne système</span>
              </div>
            </li>
          ) : (
            <li key={c.key} className={c.type}>
              <div className="col-editor-row">
                <span className="order">{i + 1}</span>
                <ColumnGlyph col={c} />
                <EmojiInput value={c.emoji} onChange={(v) => patch(i, { emoji: v })} />
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
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                  <Chevron up />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={i >= cols.length - 2}
                  onClick={() => move(i, 1)}
                  aria-label="Descendre"
                >
                  <Chevron />
                </button>
                <button
                  type="button"
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
                  <label className="col-model">
                    Modèle
                    <input
                      list="column-models"
                      placeholder="Réglage global"
                      value={c.model ?? ""}
                      onChange={(e) => patch(i, { model: e.target.value })}
                    />
                  </label>
                  <p className="hint small">Vide = modèle des réglages globaux.</p>
                  <label className="col-model">
                    Agents en parallèle dans cette colonne
                    <input
                      type="number"
                      min={1}
                      max={MAX_PARALLEL}
                      step={1}
                      placeholder="1 (défaut)"
                      value={c.maxParallel ?? ""}
                      onChange={(e) => patch(i, { maxParallel: clampParallel(e.target.value) })}
                    />
                  </label>
                  <p className="hint small">Vide = 1. Le plafond global des réglages s'applique toujours.</p>
                  <textarea
                    className="instructions"
                    placeholder="Instructions additionnelles pour l'agent (optionnel)…"
                    value={c.instructions ?? ""}
                    onChange={(e) => patch(i, { instructions: e.target.value })}
                  />
                </>
              )}
            </li>
          ),
        )}
      </ol>
      <datalist id="column-models">
        {["fable", "opus", "sonnet", "haiku"].map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </Modal>
  );
}
