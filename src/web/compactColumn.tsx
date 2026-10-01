import { columnEmoji, columnMaxParallel, type Column } from "../shared/types.ts";
import { ColumnGlyph, Icon } from "./icons.tsx";

/** A column collapses into a thin band when it is empty and not manually expanded. */
export function isCompactColumn(cardCount: number, expanded: boolean): boolean {
  return cardCount === 0 && !expanded;
}

/** Tooltip of the compact band: name, skill, model and parallelism of the column. */
export function compactColumnTitle(col: Column): string {
  const emoji = columnEmoji(col);
  const parts = [emoji ? `${emoji} ${col.name}` : col.name];
  if (col.type === "skill") {
    parts.push(col.skill ? `skill : ${col.skill}` : "skill : aucun skill");
    if (col.model !== undefined) parts.push(`modèle : ${col.model}`);
    parts.push(`0/${columnMaxParallel(col)} agents`);
  } else {
    parts.push("inerte");
  }
  return parts.join(" — ");
}

/** Content of a compact column (the caller renders the surrounding <section>). */
export function CompactColumnBand({ col, onAdd }: { col: Column; onAdd: () => void }) {
  return (
    <div className="column-band">
      <ColumnGlyph col={col} />
      <span className="count">0</span>
      <button type="button" className="band-add ghost" aria-label="Ajouter une fiche" title="Ajouter une fiche" onClick={onAdd}>
        <Icon name="plus" />
      </button>
      <h2 className="band-name">{col.name}</h2>
    </div>
  );
}
