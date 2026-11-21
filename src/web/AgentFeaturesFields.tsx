import { AGENT_FEATURES, type AgentFeature, type AgentFeaturesOverride, resolveAgentFeatures } from "../shared/agentFeatures.ts";
import type { Column, Settings } from "../shared/types.ts";
import { Label } from "./components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { useT } from "./i18n/index.ts";

type Choice = "inherit" | "on" | "off";

const choiceOf = (v: boolean | undefined): Choice => (v === undefined ? "inherit" : v ? "on" : "off");

/** Next override after one feature changes: "inherit" drops the key, and an empty object becomes undefined. */
export function agentFeaturesPatch(
  current: AgentFeaturesOverride | undefined,
  feature: AgentFeature,
  choice: Choice,
): AgentFeaturesOverride | undefined {
  const next: AgentFeaturesOverride = { ...(current ?? {}) };
  if (choice === "inherit") delete next[feature];
  else next[feature] = choice === "on";
  return Object.keys(next).length > 0 ? next : undefined;
}

/** What each feature resolves to without the level being edited: pass the levels below it (a column, the settings). */
export function inheritedFeatures(below: {
  column?: Pick<Column, "agentFeatures">;
  settings?: Pick<Settings, "agentFeatures"> | null;
}): Record<AgentFeature, boolean> {
  const r = resolveAgentFeatures({ column: below.column, settings: below.settings ?? { agentFeatures: {} } });
  return Object.fromEntries(AGENT_FEATURES.map((f) => [f, r[f].enabled])) as Record<AgentFeature, boolean>;
}

/**
 * One row per agent feature with three states: inherit (shows the value of the level below), on, off.
 * `inherited` is what each feature resolves to when this level sets nothing: compute it with `resolveAgentFeatures`
 * without this level's layer.
 */
export function AgentFeaturesFields({
  idPrefix,
  value,
  inherited,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: AgentFeaturesOverride | undefined;
  inherited: Record<AgentFeature, boolean>;
  onChange: (next: AgentFeaturesOverride | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const label = (c: Choice, f: AgentFeature) =>
    c === "inherit"
      ? t(inherited[f] ? "agentFeatures.inheritOn" : "agentFeatures.inheritOff")
      : t(c === "on" ? "agentFeatures.on" : "agentFeatures.off");
  return (
    <div className="agent-features grid gap-2">
      {AGENT_FEATURES.map((f) => {
        const choice = choiceOf(value?.[f]);
        return (
          <div key={f} className="agent-feature flex items-center justify-between gap-3 text-xs">
            <Label htmlFor={`${idPrefix}-${f}`}>{t(`agentFeatures.${f}`)}</Label>
            <Select value={choice} disabled={disabled} onValueChange={(v) => onChange(agentFeaturesPatch(value, f, v as Choice))}>
              <SelectTrigger id={`${idPrefix}-${f}`} className="w-40">
                <SelectValue>{label(choice, f)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(["inherit", "on", "off"] as const).map((c) => (
                  <SelectItem key={c} value={c}>
                    {label(c, f)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
