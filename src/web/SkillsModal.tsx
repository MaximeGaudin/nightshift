import { Plus, Search, Star, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SkillInfo } from "../shared/types.ts";
import { api } from "./api.ts";
import { CreateSkillDialog } from "./CreateSkillDialog.tsx";
import { AppDialog } from "./components/app-dialog.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useT } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** One skills list row: the select button and the favorite star are siblings so no button nests in another. */
export function SkillRow({
  skill: s,
  selected,
  favorite,
  scopeLabel,
  favoriteLabel,
  onPick,
  onToggleFavorite,
}: {
  skill: SkillInfo;
  selected: boolean;
  favorite: boolean;
  scopeLabel: string;
  favoriteLabel: string;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-9 pl-2 text-left transition-colors duration-150 hover:bg-accent aria-[current=true]:bg-accent"
        onClick={onPick}
      >
        <span className="flex items-center gap-1.5">
          <Zap className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.name}</span>
          <Badge variant={s.scope === "project" ? "default" : "secondary"}>{scopeLabel}</Badge>
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
      </button>
      <button
        type="button"
        aria-pressed={favorite}
        aria-label={favoriteLabel}
        title={favoriteLabel}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground aria-pressed:text-primary"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star className={favorite ? "size-3.5 fill-current" : "size-3.5"} />
      </button>
    </li>
  );
}

export function SkillsModal({
  project,
  favorites,
  onClose,
}: {
  project: string;
  /** Names of the favorite skills; shown by the favorite toggle. */
  favorites: string[];
  onClose: () => void;
}) {
  const { t } = useT();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");

  const reload = useCallback(
    () =>
      api
        .skills(project)
        .then(setSkills)
        .catch((e) => {
          setSkills((prev) => prev ?? []);
          notifyError(e.message);
        }),
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
      .catch((e) => notifyError(e.message));
  }, [project, selected]);

  const current = skills?.find((s) => s.name === selected);
  const dirty = content !== original;
  const query = norm(filter.trim());
  const shown = (skills ?? []).filter((s) => norm(`${s.name} ${s.description}`).includes(query));

  const confirmDiscard = () => !dirty || confirm(t("skills.discardChanges"));

  const pick = (name: string) => {
    if (name === selected || !confirmDiscard()) return;
    setSelected(name);
  };

  const toggleFavorite = (name: string, favorite: boolean) =>
    api.toggleFavoriteSkill(project, name, favorite).catch((e) => notifyError(e instanceof Error ? e.message : String(e)));

  const save = async () => {
    if (!selected) return;
    try {
      await api.saveSkill(project, selected, content);
      setOriginal(content);
      void reload();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <AppDialog
        size="xl"
        title={t("skills.title")}
        description={t("skills.description")}
        onClose={() => {
          if (confirmDiscard()) onClose();
        }}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!confirmDiscard()) return;
                setSelected(null);
                setContent("");
                setOriginal("");
                setCreating(true);
              }}
            >
              <Plus /> {t("skills.new")}
            </Button>
            <div className="flex-1" />
            {selected && (
              <Button type="button" disabled={!dirty} onClick={save}>
                {t("common.save")}
              </Button>
            )}
          </>
        }
      >
        <div className="skills grid h-[min(60vh,560px)] grid-cols-[minmax(0,280px)_minmax(0,1fr)] gap-4">
          <div className="skill-list flex min-h-0 flex-col gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("skills.searchLabel")}
                className="pl-7"
                placeholder={t("skills.searchPlaceholder")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {skills === null ? (
                ["a", "b", "c", "d"].map((k) => (
                  <li key={k} className="flex flex-col gap-1.5 px-2 py-2">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </li>
                ))
              ) : shown.length === 0 ? (
                <li className="skills-empty px-2 py-6 text-center text-xs text-muted-foreground">
                  {skills.length === 0 ? t("skills.empty") : t("skills.noMatch")}
                </li>
              ) : (
                shown.map((s) => (
                  <SkillRow
                    key={s.name}
                    skill={s}
                    selected={s.name === selected}
                    favorite={favorites.includes(s.name)}
                    scopeLabel={s.scope === "project" ? t("skills.scopeProject") : t("skills.scopeUser")}
                    favoriteLabel={favorites.includes(s.name) ? t("skills.favoriteRemove") : t("skills.favoriteAdd")}
                    onPick={() => pick(s.name)}
                    onToggleFavorite={() => toggleFavorite(s.name, !favorites.includes(s.name))}
                  />
                ))
              )}
            </ul>
          </div>
          <div className="skill-editor flex min-h-0 min-w-0 flex-col gap-2">
            {current ? (
              <>
                <p className="text-xs text-muted-foreground">
                  <code>{current.path}</code>
                  {current.scope === "user" && t("skills.userScopeNote")}
                </p>
                <Textarea
                  aria-label={t("skills.contentLabel", { name: current.name })}
                  className="min-h-0 flex-1 resize-none font-mono text-xs"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed">
                <p className="text-xs text-muted-foreground">{t("skills.pick")}</p>
              </div>
            )}
          </div>
        </div>
      </AppDialog>
      {creating && (
        <CreateSkillDialog
          project={project}
          onClose={() => setCreating(false)}
          onCreated={async (skill) => {
            await reload();
            setCreating(false);
            setSelected(skill.name);
          }}
        />
      )}
    </>
  );
}
