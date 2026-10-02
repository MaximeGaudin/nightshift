import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MODEL_ALIASES } from "../shared/models.ts";
import {
  type Column,
  ensureSystemColumns,
  isBacklogColumn,
  isDoneColumn,
  isSystemColumn,
  MAX_PARALLEL,
  type ProjectSnapshot,
  type SkillInfo,
} from "../shared/types.ts";
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
import { useT } from "./i18n/index.ts";
import { ColumnGlyph } from "./icons.tsx";
import { notifyError } from "./notify.ts";

const NO_SKILL = "__none__";

function EmojiInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const { t } = useT();
  return (
    <Input
      className="col-emoji-input h-[30px] w-10 shrink-0 px-0 text-center"
      aria-label={t("columns.emoji")}
      placeholder="·"
      title={t("columns.emojiHint")}
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

/** Checkbox state → column patch: `lockModel` is stored as `true` and omitted when off. */
export function lockModelPatch(checked: boolean): Partial<Column> {
  return { lockModel: checked ? true : undefined };
}

/** Checkbox state → column patch: `freshSession` is stored as `true` and omitted when off. */
export function freshSessionPatch(checked: boolean): Partial<Column> {
  return { freshSession: checked ? true : undefined };
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
  const { t } = useT();
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
          <IconButton
            ref={setActivatorNodeRef}
            label={t("columns.reorder", { name: col.name })}
            className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" />
          </IconButton>
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ColumnGlyph col={col} />
          </span>
          <EmojiInput value={col.emoji} onChange={(v) => onPatch({ emoji: v })} />
          <Input
            aria-label={t("columns.name")}
            className="min-w-32 flex-1"
            value={col.name}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
          <Select value={col.type} onValueChange={(v) => onPatch({ type: v as Column["type"] })}>
            <SelectTrigger aria-label={t("columns.type")} className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inert">{t("columns.typeInert")}</SelectItem>
              <SelectItem value="skill">{t("columns.typeSkill")}</SelectItem>
            </SelectContent>
          </Select>
          {isSkill &&
            (skillsLoading ? (
              <Skeleton className="h-[30px] w-40" />
            ) : (
              <Select value={col.skill || NO_SKILL} onValueChange={(v) => onPatch({ skill: v === NO_SKILL ? "" : v })}>
                <SelectTrigger aria-label={t("columns.skill")} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SKILL}>{t("columns.chooseSkill")}</SelectItem>
                  {col.skill && !skill && <SelectItem value={col.skill}>{t("columns.skillMissing", { name: col.skill })}</SelectItem>}
                  {(["project", "user"] as const).map((scope) => {
                    const scoped = skills.filter((s) => s.scope === scope);
                    if (scoped.length === 0) return null;
                    return (
                      <SelectGroup key={scope}>
                        <SelectLabel>{scope === "project" ? t("columns.projectSkills") : t("columns.userSkills")}</SelectLabel>
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
              aria-label={t("columns.parallel")}
              title={t("columns.parallelHint")}
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
                <Button type="button" variant="ghost" size="sm" aria-label={t("columns.details")} aria-expanded={open}>
                  {t("columns.details")}
                  <ChevronDown className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
            )}
            <IconButton
              label={cardCount > 0 ? t("columns.emptyBeforeDelete") : t("common.delete")}
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
                <Label htmlFor={`model-${col.key}`}>{t("columns.model")}</Label>
                <Input
                  id={`model-${col.key}`}
                  list="column-models"
                  placeholder={t("columns.modelPlaceholder")}
                  value={col.model ?? ""}
                  onChange={(e) => onPatch({ model: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t("columns.modelHint")}</p>
                <label className="lock-model flex items-center gap-2 text-xs" title={t("columns.lockModelHint")}>
                  <input type="checkbox" checked={col.lockModel === true} onChange={(e) => onPatch(lockModelPatch(e.target.checked))} />
                  {t("columns.lockModel")}
                </label>
                <label className="fresh-session flex items-center gap-2 text-xs" title={t("columns.freshSessionHint")}>
                  <input
                    type="checkbox"
                    checked={col.freshSession === true}
                    onChange={(e) => onPatch(freshSessionPatch(e.target.checked))}
                  />
                  {t("columns.freshSession")}
                </label>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor={`instructions-${col.key}`}>{t("columns.instructions")}</Label>
                <Textarea
                  id={`instructions-${col.key}`}
                  className="instructions min-h-20"
                  placeholder={t("columns.instructionsPlaceholder")}
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

function LockedSystemRow({ col, name, onPatch }: { col: Draft; name: string; onPatch: (p: Partial<Column>) => void }) {
  const { t } = useT();
  return (
    <li className="locked rounded-md border bg-secondary">
      <div className="col-editor-row flex items-center gap-2 px-2 py-1.5">
        <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
        </span>
        <EmojiInput value={col.emoji} onChange={(v) => onPatch({ emoji: v })} />
        <span className="locked-name flex-1 text-[13px] font-medium">{name}</span>
        <span className="locked-label text-xs text-muted-foreground">{t("columns.systemColumn")}</span>
      </div>
    </li>
  );
}

export function ColumnsEditor({ snap, onClose }: { snap: ProjectSnapshot; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(snap.board.name);
  const [cols, setCols] = useState<Draft[]>(() => ensureSystemColumns(snap.board.columns).columns.map((c) => ({ ...c, key: c.id })));
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
  // Radix catches Escape in the capture phase: while a keyboard drag is active, Escape must only cancel the drag.
  const dragging = useRef(false);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    dragging.current = false;
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

  const sortable = cols.filter((c) => !isSystemColumn(c));
  const backlog = cols.find(isBacklogColumn);
  const done = cols.find(isDoneColumn);

  return (
    <AppDialog
      size="lg"
      title={t("columns.title")}
      description={t("columns.description")}
      onClose={onClose}
      onEscapeKeyDown={(e) => {
        if (dragging.current) e.preventDefault();
      }}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            className="mr-auto"
            onClick={() =>
              setCols((cs) => [
                ...cs.slice(0, -1),
                { id: "", key: crypto.randomUUID(), name: t("columns.newName"), type: "inert" },
                cs[cs.length - 1],
              ])
            }
          >
            <Plus aria-hidden="true" /> {t("columns.add")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={saving} onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="board-name grid gap-1.5">
          <Label htmlFor="board-name">{t("columns.boardName")}</Label>
          <Input id="board-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="hint text-xs text-muted-foreground">
          {t("columns.hintBefore")} <strong>{t("columns.hintSkill")}</strong> {t("columns.hintAfter")}
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => {
            dragging.current = true;
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            dragging.current = false;
          }}
          accessibility={{
            screenReaderInstructions: {
              draggable: t("columns.dnd.instructions"),
            },
            announcements: {
              onDragStart: ({ active }) => t("columns.dnd.start", { name: nameOf(cols, active.id) }),
              onDragOver: ({ active, over }) =>
                over ? t("columns.dnd.over", { name: nameOf(cols, active.id), target: nameOf(cols, over.id) }) : undefined,
              onDragEnd: ({ active, over }) =>
                over
                  ? t("columns.dnd.dropOn", { name: nameOf(cols, active.id), target: nameOf(cols, over.id) })
                  : t("columns.dnd.drop", { name: nameOf(cols, active.id) }),
              onDragCancel: ({ active }) => t("columns.dnd.cancel", { name: nameOf(cols, active.id) }),
            },
          }}
        >
          <SortableContext items={sortable.map((c) => c.key)} strategy={verticalListSortingStrategy}>
            <ol className="col-editor grid gap-1.5">
              {backlog && <LockedSystemRow col={backlog} name="Backlog" onPatch={(p) => patch(backlog.key, p)} />}
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
              {done && <LockedSystemRow col={done} name="Done" onPatch={(p) => patch(done.key, p)} />}
            </ol>
          </SortableContext>
        </DndContext>
        <datalist id="column-models">
          {MODEL_ALIASES.map((m) => (
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
