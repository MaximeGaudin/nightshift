import { ChevronUp, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { useT } from "./i18n/index.ts";
import { Logo } from "./Logo.tsx";
import { cn } from "./lib/utils.ts";

export function ProjectPicker({
  recent,
  current,
  onPick,
  onCancel,
  embedded,
}: {
  recent: string[];
  current?: string;
  onPick: (path: string) => void;
  onCancel?: () => void;
  /** Inside a dialog: no brand header. */
  embedded?: boolean;
}) {
  const { t } = useT();
  const [path, setPath] = useState(current ?? "");
  const [browse, setBrowse] = useState<{ dir: string; parent: string | null; dirs: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = useCallback(
    (dir?: string) =>
      api
        .fs(dir)
        .then((b) => {
          setBrowse(b);
          setPath(b.dir);
          setError(null);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => void go(current), [go, current]);

  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className={embedded ? "flex flex-col gap-5" : "mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-12"}>
      {!embedded && (
        <header className="flex flex-col gap-1.5">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Logo size={20} />
            Nightshift
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {t("board.picker.intro.before")}
            <code className="font-mono text-xs">nightshift.json</code>
            {t("board.picker.intro.after")}
          </p>
        </header>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold">{t("board.picker.recent")}</h2>
        {recent.length > 0 ? (
          <ul className={cn("flex flex-col rounded-lg border p-1", embedded ? "bg-lane" : "bg-card")}>
            {recent.map((p) => (
              <li key={p}>
                <button type="button" className={`${row} ${p === current ? "bg-secondary" : ""}`} onClick={() => onPick(p)}>
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate font-medium">{p.split("/").pop()}</strong>
                    <span className="truncate font-mono text-xs text-muted-foreground">{p}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
            <FolderOpen className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-[13px] font-medium">{t("board.picker.noRecent")}</p>
            <p className="text-xs text-muted-foreground">{t("board.picker.noRecentHint")}</p>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold">{t("board.picker.openFolder")}</h2>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onPick(path.trim());
          }}
        >
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("board.picker.pathPlaceholder")}
            aria-label={t("board.picker.pathAria")}
          />
          <Button type="button" variant="outline" onClick={() => go(path)}>
            {t("board.picker.browse")}
          </Button>
          <Button type="submit">{t("board.picker.open")}</Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
        </form>
        {error && (
          <p className="text-xs text-err" role="alert">
            {error}
          </p>
        )}
        {browse && (
          <ul className={cn("flex max-h-64 flex-col overflow-y-auto rounded-lg border p-1", embedded ? "bg-lane" : "bg-card")}>
            {browse.parent && (
              <li>
                <button type="button" className={row} onClick={() => go(browse.parent ?? undefined)}>
                  <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">..</span>
                </button>
              </li>
            )}
            {browse.dirs.map((d) => (
              <li key={d}>
                <button type="button" className={row} onClick={() => go(`${browse.dir}/${d}`)}>
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{d}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
