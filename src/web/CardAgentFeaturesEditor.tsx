import { useState } from "react";
import type { AgentFeaturesOverride } from "../shared/agentFeatures.ts";
import type { Board, Card, Settings } from "../shared/types.ts";
import { AgentFeaturesFields, inheritedFeatures } from "./AgentFeaturesFields.tsx";
import { api } from "./api.ts";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { useT } from "./i18n/index.ts";
import { SaveStatus, useSaveStatus } from "./SaveStatus.tsx";

/** Agent features of one card, above its column's. Saved on each change; takes effect on the next run. */
export function CardAgentFeaturesEditor({
  project,
  card,
  board,
  settings,
}: {
  project: string;
  card: Card;
  board: Board;
  settings: Pick<Settings, "agentFeatures"> | null;
}) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const saveStatus = useSaveStatus();
  const column = board.columns.find((c) => c.id === card.columnId);
  const set = Object.keys(card.agentFeatures ?? {}).length;
  const save = async (next: AgentFeaturesOverride | undefined) => {
    let message: string | null = null;
    await saveStatus.track(async () => {
      try {
        await api.updateCard(project, card.id, { agentFeatures: next ?? null });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      return message === null;
    });
    setError(message);
  };
  return (
    <details className="card-agent-features min-w-0 rounded-lg border bg-lane p-3">
      <summary className="cursor-pointer text-xs font-medium select-none hover:text-foreground">
        {t("agentFeatures.title")}
        {set > 0 ? ` (${set})` : ""}
        <SaveStatus state={saveStatus.state} />
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <AgentFeaturesFields
          idPrefix={`card-features-${card.id}`}
          value={card.agentFeatures}
          inherited={inheritedFeatures({ column: column?.type === "skill" ? column : undefined, settings })}
          onChange={(next) => void save(next)}
        />
        <p className="text-xs text-muted-foreground">{t("agentFeatures.help")}</p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </details>
  );
}
