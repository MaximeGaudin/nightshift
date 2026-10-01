import { Plus, Search, Zap } from "lucide-react";
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
import { notifyError } from "./notify.ts";

const DISCARD = "Abandonner les modifications non enregistrées ?";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function SkillsModal({ project, onClose }: { project: string; onClose: () => void }) {
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

  const confirmDiscard = () => !dirty || confirm(DISCARD);

  const pick = (name: string) => {
    if (name === selected || !confirmDiscard()) return;
    setSelected(name);
  };

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
        title="Skills"
        description="Instructions réutilisables que les colonnes confient aux agents."
        onClose={() => {
          if (confirmDiscard()) onClose();
        }}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (confirmDiscard()) setCreating(true);
              }}
            >
              <Plus /> Nouveau skill (projet)
            </Button>
            <div className="flex-1" />
            {selected && (
              <Button type="button" disabled={!dirty} onClick={save}>
                Enregistrer
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
                aria-label="Rechercher un skill"
                className="pl-7"
                placeholder="Rechercher…"
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
                  {skills.length === 0
                    ? "Aucun skill pour le moment. Créez-en un avec « Nouveau skill »."
                    : "Aucun skill ne correspond à la recherche."}
                </li>
              ) : (
                shown.map((s) => (
                  <li key={s.name}>
                    <button
                      type="button"
                      aria-current={s.name === selected ? "true" : undefined}
                      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent aria-[current=true]:bg-accent"
                      onClick={() => pick(s.name)}
                    >
                      <span className="flex items-center gap-1.5">
                        <Zap className="size-3.5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.name}</span>
                        <Badge variant={s.scope === "project" ? "default" : "secondary"}>
                          {s.scope === "project" ? "projet" : "utilisateur"}
                        </Badge>
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="skill-editor flex min-h-0 min-w-0 flex-col gap-2">
            {current ? (
              <>
                <p className="text-xs text-muted-foreground">
                  <code>{current.path}</code>
                  {current.scope === "user" && " · skill utilisateur, partagé par tous vos projets"}
                </p>
                <Textarea
                  aria-label={`Contenu du skill ${current.name}`}
                  className="min-h-0 flex-1 resize-none font-mono text-xs"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed">
                <p className="text-xs text-muted-foreground">Choisissez un skill à éditer, ou créez-en un nouveau.</p>
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
