import { useEffect, useState } from "react";
import { EFFORT_LEVELS, resolveEffort } from "../shared/effort.ts";
import { MODEL_ALIASES, resolveModel } from "../shared/models.ts";
import type { Board, Card, Settings } from "../shared/types.ts";
import { api } from "./api.ts";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { useT } from "./i18n/index.ts";
import { SaveStatus, useSaveStatus } from "./SaveStatus.tsx";

export interface ModelRow {
  skill: string;
  /** Names of the skill columns that use this skill (empty for an entry whose skill no column uses). */
  columns: string[];
  /** Model that applies when the card has no entry: column, then settings, then "default". */
  fallback: string;
  /** Effort that applies when the card has no entry, e.g. "low" or "inherit". */
  effortFallback: string;
  unused: boolean;
}

/** One row per distinct skill of the board's skill columns, then one per extra key of the card's map. */
export function modelRows(board: Board, card: Card, settings: Pick<Settings, "model" | "effort"> | null | undefined): ModelRow[] {
  const bySkill = new Map<string, { columns: string[]; fallbacks: string[]; efforts: string[] }>();
  for (const col of board.columns) {
    if (col.type !== "skill" || !col.skill) continue;
    const row = bySkill.get(col.skill) ?? { columns: [], fallbacks: [], efforts: [] };
    row.columns.push(col.name);
    const fallback = resolveModel(col, { model: settings?.model ?? "" }).model ?? "default";
    if (!row.fallbacks.includes(fallback)) row.fallbacks.push(fallback);
    const e = resolveEffort(col, { effort: settings?.effort ?? "" });
    const effort = e.effort ?? "inherit";
    if (!row.efforts.includes(effort)) row.efforts.push(effort);
    bySkill.set(col.skill, row);
  }
  const rows: ModelRow[] = [...bySkill].map(([skill, r]) => ({
    skill,
    columns: r.columns,
    fallback: r.fallbacks.join(" / "),
    effortFallback: r.efforts.join(" / "),
    unused: false,
  }));
  for (const skill of new Set([...Object.keys(card.models ?? {}), ...Object.keys(card.efforts ?? {})])) {
    if (!bySkill.has(skill)) rows.push({ skill, columns: [], fallback: "default", effortFallback: "inherit", unused: true });
  }
  return rows;
}

/** The full map to send: trimmed, empty entries omitted. */
export function buildModels(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [skill, value] of Object.entries(values)) {
    const v = value.trim();
    if (v) out[skill] = v;
  }
  return out;
}

/** Sends the full map; resolves to the server error text (shown inline), or null when saved. */
export async function saveCardModels({
  project,
  cardId,
  values,
  efforts,
  update = api.updateCard,
}: {
  project: string;
  cardId: string;
  values: Record<string, string>;
  /** Per-skill efforts, sent in the same PATCH as the models; absent = efforts untouched. */
  efforts?: Record<string, string>;
  update?: (project: string, id: string, patch: { models: Record<string, string>; efforts?: Record<string, string> }) => Promise<unknown>;
}): Promise<string | null> {
  try {
    await update(project, cardId, { models: buildModels(values), ...(efforts ? { efforts: buildModels(efforts) } : {}) });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Per-skill model overrides of one card. Empty = the column or settings model. Takes effect on the next run. */
export function CardModelsEditor({
  project,
  card,
  board,
  settings,
}: {
  project: string;
  card: Card;
  board: Board;
  settings: Pick<Settings, "model" | "effort"> | null;
}) {
  const { t } = useT();
  const server = card.models ?? {};
  const serverKey = JSON.stringify(server);
  const serverEfforts: Record<string, string> = card.efforts ?? {};
  const serverEffortsKey = JSON.stringify(serverEfforts);
  const [values, setValues] = useState<Record<string, string>>(server);
  const [effortValues, setEffortValues] = useState<Record<string, string>>(serverEfforts);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveStatus = useSaveStatus();
  // biome-ignore lint/correctness/useExhaustiveDependencies: serverKey is the trigger (the server map changed); server is derived from it
  useEffect(() => setValues(server), [serverKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: same pattern as above, for the efforts map
  useEffect(() => setEffortValues(serverEfforts), [serverEffortsKey]);
  const rows = modelRows(board, card, settings);
  if (rows.length === 0) return null;
  const dirty =
    JSON.stringify(buildModels(values)) !== JSON.stringify(buildModels(server)) ||
    JSON.stringify(buildModels(effortValues)) !== JSON.stringify(buildModels(serverEfforts));
  const submit = async (next: Record<string, string>, nextEfforts: Record<string, string>) => {
    setSaving(true);
    let message: string | null = null;
    const ok = await saveStatus.track(async () => {
      message = await saveCardModels({ project, cardId: card.id, values: next, efforts: nextEfforts });
      return message === null;
    });
    setSaving(false);
    setError(message);
    return ok;
  };
  const overrides = Object.keys(buildModels(server)).length + Object.keys(buildModels(serverEfforts)).length;
  return (
    <details className="card-models min-w-0 rounded-lg border bg-lane p-3">
      <summary className="cursor-pointer text-xs font-medium select-none hover:text-foreground">
        {t("card.models.title")}
        {overrides > 0 ? ` (${overrides})` : ""}
        <SaveStatus state={saveStatus.state} />
      </summary>
      <form
        className="mt-2 flex min-w-0 flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(values, effortValues);
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-end"
          disabled={saving || Object.keys(values).length + Object.keys(effortValues).length === 0}
          onClick={() => {
            setValues({});
            setEffortValues({});
            void submit({}, {}).then((ok) => {
              if (!ok) {
                setValues(server);
                setEffortValues(serverEfforts);
              }
            });
          }}
        >
          {t("card.models.clearAll")}
        </Button>
        {rows.map((r) => (
          <div key={r.skill} className="model-row grid gap-1">
            <label htmlFor={`card-model-${r.skill}`} className="text-xs text-muted-foreground">
              {r.unused
                ? t("card.models.unused", { skill: r.skill })
                : t("card.models.skillRow", { skill: r.skill, columns: r.columns.join(", ") })}
            </label>
            <Input
              id={`card-model-${r.skill}`}
              list="card-models-list"
              placeholder={r.fallback}
              value={values[r.skill] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [r.skill]: e.target.value }))}
            />
            <label htmlFor={`card-effort-${r.skill}`} className="sr-only">
              {t("card.models.effort", { skill: r.skill })}
            </label>
            <select
              id={`card-effort-${r.skill}`}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={effortValues[r.skill] ?? ""}
              onChange={(e) => setEffortValues((v) => ({ ...v, [r.skill]: e.target.value }))}
            >
              <option value="">{t("card.models.effortDefault", { effort: r.effortFallback })}</option>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        ))}
        <datalist id="card-models-list">
          {MODEL_ALIASES.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {error && (
          <Alert variant="destructive" className="models-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="sm" className="self-start" disabled={saving || !dirty}>
          {t("card.models.save")}
        </Button>
      </form>
    </details>
  );
}
