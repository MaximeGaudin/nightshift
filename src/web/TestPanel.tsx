import { useEffect, useRef, useState } from "react";
import type { Card, LogLine } from "../shared/types.ts";
import { safeHttpUrl } from "../shared/urls.ts";
import { api, useServerEvents } from "./api.ts";

/** Runs the card's test command (set by an agent, editable here) and streams its output. */
export function TestPanel({
  project,
  card,
  running,
  onError,
}: {
  project: string;
  card: Card;
  running: boolean;
  onError: (message: string) => void;
}) {
  const linkUrl = safeHttpUrl(card.test?.url);
  const [editing, setEditing] = useState(false);
  const [command, setCommand] = useState(card.test?.command ?? "");
  const [url, setUrl] = useState(card.test?.url ?? "");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [showOutput, setShowOutput] = useState(running);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) return;
    setCommand(card.test?.command ?? "");
    setUrl(card.test?.url ?? "");
  }, [card.test?.command, card.test?.url]);
  useEffect(
    () =>
      void api
        .testLog(project, card.id)
        .then(setLines)
        .catch(() => {}),
    [card.id],
  );
  useServerEvents((e) => {
    if (e.type !== "testlog" || e.project !== project || e.cardId !== card.id) return;
    setLines((l) => (e.line.text.startsWith("$ ") ? [e.line] : [...l, e.line]));
  });
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, showOutput]);

  const guard = (p: Promise<unknown>) => p.catch((e) => onError(e.message));

  if (!card.test && !editing) {
    return (
      <button className="test-add" onClick={() => setEditing(true)}>
        + Commande de test
      </button>
    );
  }

  if (editing) {
    return (
      <form
        className="test-panel"
        onSubmit={(e) => {
          e.preventDefault();
          guard(api.setTest(project, card.id, command, url).then(() => setEditing(false)));
        }}
      >
        <strong>Commande de test</strong>
        <label>
          Commande (lancée avec sh -c depuis le dossier du projet)
          <textarea className="code" value={command} onChange={(e) => setCommand(e.target.value)} autoFocus />
        </label>
        <label>
          URL (optionnel)
          <input value={url} placeholder="http://localhost:4546" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="row">
          <div className="spacer" />
          <button type="button" onClick={() => setEditing(false)}>
            Annuler
          </button>
          <button className="primary" type="submit">
            Enregistrer
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="test-panel">
      <div className="row">
        <strong>Tester</strong>
        {running && <span className="spinner" aria-hidden />}
        <div className="spacer" />
        <button className="icon-btn" onClick={() => setEditing(true)} disabled={running}>
          Modifier
        </button>
        {running ? (
          <button onClick={() => guard(api.stopTest(project, card.id))}>Arrêter</button>
        ) : (
          <button
            className="primary"
            onClick={() => {
              setShowOutput(true);
              guard(api.startTest(project, card.id));
            }}
          >
            Lancer
          </button>
        )}
      </div>
      <pre className="test-command">{card.test!.command}</pre>
      {linkUrl && (
        <a href={linkUrl} target="_blank" rel="noreferrer">
          {linkUrl}
        </a>
      )}
      {lines.length > 0 && (
        <button className="test-toggle" onClick={() => setShowOutput((s) => !s)}>
          {showOutput ? "Masquer la sortie" : "Afficher la sortie"}
        </button>
      )}
      {showOutput && lines.length > 0 && (
        <div className="log test-output" ref={outRef}>
          {lines.map((l, i) => (
            <div key={i} className={`log-line ${l.kind}`}>
              <time>{new Date(l.at).toLocaleTimeString("fr-FR")}</time>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
