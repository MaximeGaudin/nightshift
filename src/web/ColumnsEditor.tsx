import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Column, ensureDoneColumn, isDoneColumn, MAX_PARALLEL, type ProjectSnapshot, type SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { type KeyedColumn, reorderColumns } from "./columnOrder.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { IconButton } from "./components/icon-button.tsx";
import { Button } from "./components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { usePrefersReducedMotion } from "./hooks/use-reduced-motion.ts";
import { ColumnGlyph } from "./icons.tsx";
import { notifyError } from "./notify.ts";

const EMOJI_TITLE = "Emoji optionnel — tapez ou collez-en un (macOS : Ctrl+Cmd+Espace). Vide = icône de type.";
const NO_SKILL = "__none__";

function EmojiInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  return (
    <Input
      className="col-emoji-input h-[30px] w-10 shrink-0 px-0 text-center"
      aria-label="Emoji"
      placeholder="·"
      title={EMOJI_TITLE}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

type Draft = KeyedColumn;

/** Empty input → undefined (column default); otherwise an integer clamped to 1–MAX_PARALLEL. */
function clampParallel(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_PARALLEL, Math.max(1, n));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RowProps = {
  col: Draft;
  skills: SkillInfo[];
  skillsLoading: boolean;
  cardCount: number;
  reducedMotion: boolean;
  onPatch: (p: Partial<Column>) => void;
  onRemove: () => void;
};

function SortableColumnRow({ col, skills, skillsLoading, cardCount, reducedMotion, onPatch, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: col.key });
  const [open, setOpen] = useState(false);
  const isSkill = col.type === "skill";
  const skill = skills.find((s) => s.name === col.skill);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`${col.type} rounded-md border bg-card ${isDragging ? "relative z-10 opacity-80 shadow-xs" : ""}`}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="col-editor-row flex flex-wrap items-center gap-2 px-2 py-1.5">
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Réordonner la colonne ${col.name}`}
            className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" aria-hidden="true" />
          </button>
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ColumnGlyph col={col} />
          </span>
          <EmojiInput value={col.emoji} onChange={(v) => onPatch({ emoji: v })} />
          <Input aria-label="Nom" className="min-w-32 flex-1" value={col.name} onChange={(e) => onPatch({ name: e.target.value })} />
          <Select value={col.type} onValueChange={(v) => onPatch({ type: v as Column["type"] })}>
            <SelectTrigger aria-label="Type" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inert">Inerte</SelectItem>
              <SelectItem value="skill">Skill</SelectItem>
            </SelectContent>
          </Select>
          {isSkill &&
            (skillsLoading ? (
              <Skeleton className="h-[30px] w-40" />
            ) : (
              <Select value={col.skill || NO_SKILL} onValueChange={(v) => onPatch({ skill: v === NO_SKILL ? "" : v })}>
                <SelectTrigger aria-label="Skill" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SKILL}>— choisir un skill —</SelectItem>
                  {col.skill && !skill && <SelectItem value={col.skill}>{col.skill} (introuvable)</SelectItem>}
                  {(["project", "user"] as const).map((scope) => {
                    const scoped = skills.filter((s) => s.scope === scope);
                    if (scoped.length === 0) return null;
                    return (
                      <SelectGroup key={scope}>
                        <SelectLabel>{scope === "project" ? "Skills du projet" : "Skills utilisateur"}</SelectLabel>
                        {scoped.map((s) => (
                          <SelectItem key={s.name} value={s.name}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
            ))}
          {isSkill && (
            <Input
              type="number"
              aria-label="Agents en parallèle"
              title="Agents en parallèle dans cette colonne. Vide = 1. Le plafond global des réglages s'applique toujours."
              className="w-20"
              min={1}
              max={MAX_PARALLEL}
              step={1}
              placeholder="1"
              value={col.maxParallel ?? ""}
              onChange={(e) => onPatch({ maxParallel: clampParallel(e.target.value) })}
            />
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {isSkill && (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" aria-label="Détails" aria-expanded={open}>
                  Détails
                  <ChevronDown className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
            )}
            <IconButton
              label={cardCount > 0 ? "Videz la colonne avant de la supprimer" : "Supprimer"}
              disabled={cardCount > 0}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        {isSkill && (
          <CollapsibleContent>
            <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
              {skill?.description && <p className="text-xs text-muted-foreground sm:col-span-2">{skill.description}</p>}
              <div className="grid gap-1.5">
                <Label htmlFor={`model-${col.key}`}>Modèle</Label>
                <Input
                  id={`model-${col.key}`}
                  list="column-models"
                  placeholder="Réglage global"
                  value={col.model ?? ""}
                  onChange={(e) => onPatch({ model: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Vide = modèle des réglages globaux.</p>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor={`instructions-${col.key}`}>Instructions</Label>
                <Textarea
                  id={`instructions-${col.key}`}
                  className="instructions min-h-20"
                  placeholder="Instructions additionnelles pour l'agent (optionnel)…"
                  value={col.instructions ?? ""}
                  onChange={(e) => onPatch({ instructions: e.target.value })}
                />
              </div>
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

function LockedDoneRow({ col, onPatch }: { col: Draft; onPatch: (p: Partial<Column>) => void }) {
  return (
    <li className="locked rounded-md border bg-secondary">
      <div className="col-editor-row flex items-center gap-2 px-2 py-1.5">
        <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
        </span>
        <EmojiInput value={col.emoji} onChange={(v) => onPatch({ emoji: v })} />
        <span className="locked-name flex-1 text-[13px] font-medium">Done</span>
        <span className="locked-label text-xs text-muted-foreground">Colonne système</span>
      </div>
    </li>
  );
}

export function ColumnsEditor({ snap, onClose }: { snap: ProjectSnapshot; onClose: () => void }) {
  const [name, setName] = useState(snap.board.name);
  const [cols, setCols] = useState<Draft[]>(() => ensureDoneColumn(snap.board.columns).map((c) => ({ ...c, key: c.id })));
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    let live = true;
    setSkillsLoading(true);
    api
      .skills(snap.path)
      .then((s) => live && setSkills(s))
      .catch((e) => notifyError(errorMessage(e)))
      .finally(() => live && setSkillsLoading(false));
    return () => {
      live = false;
    };
  }, [snap.path]);

  const count = (id: string) => (id ? snap.board.cards.filter((c) => c.columnId === id).length : 0);
  const patch = (key: string, p: Partial<Column>) => setCols((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) setCols((cs) => reorderColumns(cs, String(active.id), String(over.id)));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveBoard(snap.path, {
        name,
        columns: cols.map(({ key, ...c }) => c),
      });
      onClose();
    } catch (e) {
      notifyError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const sortable = cols.filter((c) => !isDoneColumn(c));
  const done = cols.find(isDoneColumn);

  return (
    <AppDialog
      size="lg"
      title="Colonnes du kanban"
      description="Ordonnez les colonnes, choisissez leur type et le skill exécuté."
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            className="mr-auto"
            onClick={() =>
              setCols((cs) => [
                ...cs.slice(0, -1),
                { id: "", key: crypto.randomUUID(), name: "Nouvelle colonne", type: "inert" },
                cs[cs.length - 1],
              ])
            }
          >
            <Plus aria-hidden="true" /> Colonne
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="button" disabled={saving} onClick={save}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="board-name grid gap-1.5">
          <Label htmlFor="board-name">Nom du kanban</Label>
          <Input id="board-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="hint text-xs text-muted-foreground">
          Une colonne <strong>skill</strong> exécute le skill choisi sur chaque fiche qui y arrive. Chaque colonne skill a sa propre limite
          d'agents en parallèle (1 par défaut), sous le plafond global des réglages. Le skill peut modifier la fiche puis l'envoyer à la
          colonne suivante. Le champ emoji (optionnel) remplace l'icône de type de la colonne.
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "Pour réordonner une colonne, appuyez sur Espace, déplacez-la avec les flèches haut et bas, puis appuyez sur Espace pour la déposer ou sur Échap pour annuler.",
            },
            announcements: {
              onDragStart: ({ active }) => `Colonne ${nameOf(cols, active.id)} saisie`,
              onDragOver: ({ active, over }) =>
                over ? `Colonne ${nameOf(cols, active.id)} au-dessus de ${nameOf(cols, over.id)}` : undefined,
              onDragEnd: ({ active, over }) =>
                over
                  ? `Colonne ${nameOf(cols, active.id)} déposée à la place de ${nameOf(cols, over.id)}`
                  : `Colonne ${nameOf(cols, active.id)} déposée`,
              onDragCancel: ({ active }) => `Déplacement de la colonne ${nameOf(cols, active.id)} annulé`,
            },
          }}
        >
          <SortableContext items={sortable.map((c) => c.key)} strategy={verticalListSortingStrategy}>
            <ol className="col-editor grid gap-1.5">
              {sortable.map((c) => (
                <SortableColumnRow
                  key={c.key}
                  col={c}
                  skills={skills}
                  skillsLoading={skillsLoading}
                  cardCount={count(c.id)}
                  reducedMotion={reducedMotion}
                  onPatch={(p) => patch(c.key, p)}
                  onRemove={() => setCols((cs) => cs.filter((x) => x.key !== c.key))}
                />
              ))}
              {done && <LockedDoneRow col={done} onPatch={(p) => patch(done.key, p)} />}
            </ol>
          </SortableContext>
        </DndContext>
        <datalist id="column-models">
          {["fable", "opus", "sonnet", "haiku"].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    </AppDialog>
  );
}

function nameOf(cols: Draft[], id: string | number): string {
  return cols.find((c) => c.key === String(id))?.name ?? String(id);
}
