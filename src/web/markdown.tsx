// Markdown rendering for card descriptions, agent questions and run summaries.
// Provisional implementation: renders the source as plain text (React escapes it,
// no HTML injection); `.md` keeps line breaks via `white-space: pre-wrap`.

export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className ? `md ${className}` : "md"}>{source}</div>;
}

/** Text without markdown syntax, for card excerpts. Provisional: returns the source unchanged. */
export function toPlainText(source: string): string {
  return source;
}
