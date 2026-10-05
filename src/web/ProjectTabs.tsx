import { Folder, Plus, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./components/icon-button.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { questionCount, type TabsState, tabLabel, waitingCount } from "./projectTabs.ts";

/** Browser-like tab bar of the open projects, above the board panel. */
export function ProjectTabs({
  state,
  active,
  leading,
  onSelect,
  onClose,
  onAdd,
}: {
  state: TabsState;
  active: string | null;
  /** Shown before the tabs (the app logo). */
  leading?: ReactNode;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Opens the project picker; absent when the picker is already on screen. */
  onAdd?: () => void;
}) {
  const { t } = useT();
  return (
    <div className="project-tabs flex h-10 shrink-0 items-center gap-1 px-2.5">
      {leading}
      <div role="tablist" aria-label={t("board.tabs.label")} className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {state.tabs.map((path) => {
          const selected = path === active;
          const snap = state.snaps[path];
          const error = state.errors[path];
          const questions = snap ? questionCount(snap) : 0;
          const waiting = snap ? waitingCount(snap) : 0;
          const name = tabLabel(path);
          return (
            <div
              key={path}
              className={cn(
                "project-tab group/tab flex h-7 max-w-56 min-w-0 shrink-0 items-center rounded-md border border-transparent pr-1 transition-colors duration-150",
                selected ? "border-border bg-panel text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={error ? t("board.tabs.openFailed", { error }) : path}
                className="flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(path)}
              >
                {error ? (
                  <TriangleAlert className="tab-error size-3.5 shrink-0 text-err" aria-hidden="true" focusable="false" />
                ) : (
                  <Folder className="size-3.5 shrink-0 opacity-70" aria-hidden="true" focusable="false" />
                )}
                <span className="truncate">{name}</span>
                {questions > 0 && (
                  <span
                    className="tab-questions rounded-full bg-warn-soft px-1.5 text-[11px] leading-4 font-medium text-warn tabular-nums"
                    title={t("board.tabs.questions")}
                  >
                    {questions}
                  </span>
                )}
                {waiting > 0 && (
                  <span
                    className="tab-waiting rounded-full bg-accent px-1.5 text-[11px] leading-4 font-medium text-foreground tabular-nums"
                    title={t("board.tabs.waiting")}
                  >
                    {waiting}
                  </span>
                )}
              </button>
              <IconButton
                label={t("board.tabs.close", { name })}
                className={cn(
                  "tab-close ml-0.5 size-5 text-muted-foreground hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                  selected ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(path);
                }}
              >
                <X size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
              </IconButton>
            </div>
          );
        })}
      </div>
      {onAdd && (
        <IconButton label={t("board.tabs.add")} className="tab-add size-7 shrink-0 text-muted-foreground" onClick={onAdd}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        </IconButton>
      )}
    </div>
  );
}
