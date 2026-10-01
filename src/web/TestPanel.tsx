import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

  // Re-runs only when the test changes on the server: a form being edited is kept, so `editing` is read through a ref.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (editingRef.current) return;
    setCommand(card.test?.command ?? "");
    setUrl(card.test?.url ?? "");
  }, [card.test?.command, card.test?.url]);
  useEffect(
    () =>
      void api
        .testLog(project, card.id)
        .then(setLines)
        .catch(() => {}),
    [project, card.id],
  );
  useServerEvents((e) => {
    if (e.type !== "testlog" || e.project !== project || e.cardId !== card.id) return;
    setLines((l) => (e.line.text.startsWith("$ ") ? [e.line] : [...l, e.line]));
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: new lines and the output being shown are the triggers (scroll to the end); the effect only reads the DOM
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, showOutput]);

  const guard = (p: Promise<unknown>) => p.catch((e) => onError(e.message));

  if (!card.test && !editing) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="test-add shrink-0 self-start border-dashed text-muted-foreground"
        onClick={() => setEditing(true)}
      >
        + Commande de test
      </Button>
    );
  }

  if (editing) {
    return (
      <form
        className="test-panel flex shrink-0 flex-col gap-2 rounded-md border bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          guard(api.setTest(project, card.id, command, url).then(() => setEditing(false)));
        }}
      >
        <strong className="text-[13px] font-semibold">Commande de test</strong>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-command">Commande (lancée avec sh -c depuis le dossier du projet)</Label>
          <Textarea
            id="test-command"
            className="code min-h-[60px] font-mono"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-url">URL (optionnel)</Label>
          <Input id="test-url" value={url} placeholder="http://localhost:4546" onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setEditing(false)}>
            Annuler
          </Button>
          <Button type="submit">Enregistrer</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="test-panel flex shrink-0 flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-center gap-2">
        <strong className="text-[13px] font-semibold">Tester</strong>
        {running && <Loader2 className="animate-spin text-muted-foreground" aria-hidden />}
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={running}>
          Modifier
        </Button>
        {running ? (
          <Button type="button" variant="outline" size="sm" onClick={() => guard(api.stopTest(project, card.id))}>
            Arrêter
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setShowOutput(true);
              guard(api.startTest(project, card.id));
            }}
          >
            Lancer
          </Button>
        )}
      </div>
      <pre className="test-command m-0 rounded-sm bg-secondary px-2 py-1.5 font-mono text-xs leading-normal break-all whitespace-pre-wrap">
        {card.test?.command}
      </pre>
      {linkUrl && (
        <a href={linkUrl} target="_blank" rel="noreferrer" className="text-[13px] text-primary hover:underline">
          {linkUrl}
        </a>
      )}
      {lines.length > 0 && (
        <button
          type="button"
          className="test-toggle cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowOutput((s) => !s)}
        >
          {showOutput ? "Masquer la sortie" : "Afficher la sortie"}
        </button>
      )}
      {showOutput && lines.length > 0 && (
        <div
          className="log test-output max-h-[180px] min-h-0 flex-none overflow-auto rounded-sm bg-secondary px-2 py-1.5 font-mono text-xs leading-relaxed"
          ref={outRef}
        >
          {lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no id and the list only grows at its end
            <div key={i} className={`log-line grid grid-cols-[70px_minmax(0,1fr)] gap-3 py-px ${l.kind}`}>
              <time className="text-muted-foreground tabular-nums">{new Date(l.at).toLocaleTimeString("fr-FR")}</time>
              <span
                className={`break-words whitespace-pre-wrap ${l.kind === "error" ? "text-err" : l.kind === "info" ? "text-muted-foreground" : l.kind === "tool" ? "text-primary" : ""}`}
              >
                {l.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
